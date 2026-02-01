# acme-love-route53

AWS Route 53 DNS-01 challenge solver for [acme-love](https://www.npmjs.com/package/acme-love) — automate Let's Encrypt certificates with Route 53.

## Installation

```bash
npm install acme-love acme-love-route53 @aws-sdk/client-route-53
```

## Usage

```typescript
import {
  AcmeClient,
  AcmeAccount,
  provider,
  generateKeyPair,
  createAcmeCsr,
} from "acme-love";
import { createRoute53Dns01Solver } from "acme-love-route53";

const client = new AcmeClient(provider.letsencrypt.production);

const algo = { kind: "ec", namedCurve: "P-256", hash: "SHA-256" } as const;
const accountKeys = await generateKeyPair(algo);
const account = new AcmeAccount(client, accountKeys);
await account.register({
  contact: "admin@example.com",
  termsOfServiceAgreed: true,
});

const order = await account.createOrder(["example.com", "*.example.com"]);

// Create Route 53 DNS-01 solver
const solver = createRoute53Dns01Solver({
  region: "us-east-1",
});

// Solve challenges automatically
const ready = await account.solveDns01(order, solver);

// Finalize and download certificate
const { derBase64Url } = await createAcmeCsr(
  ["example.com", "*.example.com"],
  algo,
);
const finalized = await account.finalize(ready, derBase64Url);
const valid = await account.waitOrder(finalized, ["valid"]);
const cert = await account.downloadCertificate(valid);
```

## Configuration

```typescript
const solver = createRoute53Dns01Solver({
  // Optional: AWS region (default: us-east-1)
  region: "us-east-1",

  // Optional: hosted zone ID (auto-detected if omitted)
  hostedZoneId: "Z1234567890",

  // Optional: DNS propagation check interval (default: 5000ms)
  propagationInterval: 5_000,

  // Optional: max propagation wait time (default: 120000ms)
  propagationTimeout: 120_000,

  // Optional: custom Route53Client instance
  client: new Route53Client({
    region: "eu-west-1",
    credentials: myCredentials,
  }),
});
```

## AWS Credentials

This package uses the AWS SDK default credential chain. Configure credentials via:

- Environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
- AWS credentials file (`~/.aws/credentials`)
- IAM role (EC2, ECS, Lambda)
- SSO / `aws configure sso`

Required IAM permissions:

```json
{
  "Effect": "Allow",
  "Action": [
    "route53:ChangeResourceRecordSets",
    "route53:GetChange",
    "route53:ListHostedZonesByName"
  ],
  "Resource": "*"
}
```

## Cleanup

After certificate issuance, remove the TXT records:

```typescript
await solver.cleanup(preparation);
```

## Requirements

- Node.js >= 22
- acme-love >= 2.0.0
- @aws-sdk/client-route-53 >= 3.0.0

## License

MIT
