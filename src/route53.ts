import type { ChallengePreparation } from "acme-love";
import {
  Route53Client,
  ChangeResourceRecordSetsCommand,
  ListHostedZonesByNameCommand,
  GetChangeCommand,
  type ChangeResourceRecordSetsCommandInput,
} from "@aws-sdk/client-route-53";

export interface Route53Config {
  /** AWS region (default: us-east-1) */
  region?: string;
  /** Hosted zone ID. If omitted, resolved automatically from the domain. */
  hostedZoneId?: string;
  /** Propagation check interval in ms (default: 5000) */
  propagationInterval?: number;
  /** Maximum propagation wait time in ms (default: 120000) */
  propagationTimeout?: number;
  /** Optional Route53Client instance for custom credentials */
  client?: Route53Client;
}

export interface Route53Dns01Solver {
  setDns: (preparation: ChallengePreparation) => Promise<void>;
  waitFor: (preparation: ChallengePreparation) => Promise<void>;
  cleanup: (preparation: ChallengePreparation) => Promise<void>;
}

async function findHostedZoneId(
  r53: Route53Client,
  domain: string,
): Promise<string> {
  const parts = domain.replace(/^_acme-challenge\./, "").split(".");

  for (let i = 0; i < parts.length - 1; i++) {
    const zone = parts.slice(i).join(".");
    const cmd = new ListHostedZonesByNameCommand({
      DNSName: zone,
      MaxItems: 1,
    });
    const res = await r53.send(cmd);

    const match = res.HostedZones?.find(
      (hz) => hz.Name === `${zone}.` || hz.Name === zone,
    );

    if (match?.Id) {
      return match.Id.replace("/hostedzone/", "");
    }
  }

  throw new Error(`Could not find Route 53 hosted zone for domain: ${domain}`);
}

async function changeRecordSet(
  r53: Route53Client,
  zoneId: string,
  action: "UPSERT" | "DELETE",
  name: string,
  value: string,
): Promise<string | undefined> {
  const input: ChangeResourceRecordSetsCommandInput = {
    HostedZoneId: zoneId,
    ChangeBatch: {
      Changes: [
        {
          Action: action,
          ResourceRecordSet: {
            Name: name,
            Type: "TXT",
            TTL: 120,
            ResourceRecords: [{ Value: `"${value}"` }],
          },
        },
      ],
    },
  };

  const res = await r53.send(new ChangeResourceRecordSetsCommand(input));
  return res.ChangeInfo?.Id;
}

async function waitForChange(
  r53: Route53Client,
  changeId: string,
  timeout: number,
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const res = await r53.send(new GetChangeCommand({ Id: changeId }));
    if (res.ChangeInfo?.Status === "INSYNC") return;
    await new Promise((r) => setTimeout(r, 2_000));
  }

  throw new Error(
    `Route 53 change ${changeId} did not sync within ${timeout}ms`,
  );
}

/**
 * Creates an AWS Route 53 DNS-01 challenge solver for use with acme-love.
 *
 * @example
 * ```ts
 * import { createRoute53Dns01Solver } from 'acme-love-route53';
 *
 * const solver = createRoute53Dns01Solver({
 *   region: 'us-east-1',
 * });
 *
 * const ready = await account.solveDns01(order, solver);
 * await solver.cleanup(preparation); // remove TXT records after
 * ```
 */
export function createRoute53Dns01Solver(
  config: Route53Config = {},
): Route53Dns01Solver {
  const {
    region = "us-east-1",
    propagationInterval = 5_000,
    propagationTimeout = 120_000,
  } = config;

  const r53 = config.client ?? new Route53Client({ region });

  async function getZoneId(target: string): Promise<string> {
    if (config.hostedZoneId) return config.hostedZoneId;
    return findHostedZoneId(r53, target);
  }

  const setDns = async (preparation: ChallengePreparation): Promise<void> => {
    const zoneId = await getZoneId(preparation.target);
    const changeId = await changeRecordSet(
      r53,
      zoneId,
      "UPSERT",
      preparation.target,
      preparation.value,
    );

    if (changeId) {
      await waitForChange(r53, changeId, 30_000);
    }
  };

  const waitFor = async (preparation: ChallengePreparation): Promise<void> => {
    const start = Date.now();

    while (Date.now() - start < propagationTimeout) {
      try {
        const { resolve } = await import("node:dns/promises");
        const records = await resolve(preparation.target, "TXT");
        const flat = records.flat();
        if (flat.includes(preparation.value)) return;
      } catch {
        // DNS not propagated yet
      }
      await new Promise((r) => setTimeout(r, propagationInterval));
    }

    throw new Error(
      `DNS propagation timeout after ${propagationTimeout}ms for ${preparation.target}`,
    );
  };

  const cleanup = async (preparation: ChallengePreparation): Promise<void> => {
    const zoneId = await getZoneId(preparation.target);
    await changeRecordSet(
      r53,
      zoneId,
      "DELETE",
      preparation.target,
      preparation.value,
    );
  };

  return { setDns, waitFor, cleanup };
}
