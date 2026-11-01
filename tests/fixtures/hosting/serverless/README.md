# Serverless deploy-check fixture

The image `pnpm hosting:deploy-check --target serverless` builds and deploys
(MOTIR-9975): `server.mjs` behind the Lambda Web Adapter, its release label
baked in with `--build-arg RELEASE_LABEL=<label>`. `serverless-worker/` beside
it is the same manifest declaring background work, which the target refuses.
