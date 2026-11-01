# Starter hosting manifests

Verbatim copies of the `motir.hosting.json` each web starter ships at its root,
taken on 2026-10-29 for MOTIR-9813. `tests/projectRepos/seedRegistryEntries.test.ts`
parses them with the shipped `parseHostingManifest` and holds each registry
entry's `hosting_targets` to a subset of its manifest's `targets`.

| fixture           | repository                                                                                        | commit                                     |
| ----------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `serverless.json` | [motir-co/nextjs-prisma-vercel-starter](https://github.com/motir-co/nextjs-prisma-vercel-starter) | `b1dbc06ff7f5804ab2b8cd0b7dbc720629b6e5e2` |
| `fly.json`        | [motir-co/nextjs-prisma-fly-starter](https://github.com/motir-co/nextjs-prisma-fly-starter)       | `2158a17aabdac691e6feae042baa1040a6eedc0d` |
| `aws.json`        | [motir-co/nextjs-prisma-aws-starter](https://github.com/motir-co/nextjs-prisma-aws-starter)       | `1ea8db4b0fac88ee759f82f307dcb729787ba368` |

The serverless starter's registry entry names its template
`motir-co/nextjs-prisma-serverless-starter` (706 3.4); the repository still
answers under its old name, `nextjs-prisma-vercel-starter`.

The two non-web foundations (`expo-mobile-foundation`, `spring-api-foundation`)
ship no manifest: their entries carry no hosting target (706 3.2).

To refresh a fixture, re-read the live file — `pnpm tsx scripts/seed-registry/verify-starter-manifests.ts`
prints each manifest's commit — and update this table with it.
