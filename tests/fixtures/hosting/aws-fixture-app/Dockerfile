# The AWS deploy check's fixture image (MOTIR-10011). One image for both shapes:
# ECS runs the HTTP server as it is; Lambda runs it through the Lambda Web
# Adapter, an extension that turns invocations into HTTP requests on $PORT.
# Built by `pnpm hosting:deploy-check push` with `--build-arg RELEASE=1|2`, so the
# two releases are different digests that answer differently.
ARG LAMBDA_WEB_ADAPTER=public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1
FROM ${LAMBDA_WEB_ADAPTER} AS adapter

FROM node:22-slim
COPY --from=adapter /lambda-adapter /opt/extensions/lambda-adapter
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs ./
ARG RELEASE=1
ENV MOTIR_FIXTURE_RELEASE=${RELEASE} \
    PORT=8080 \
    AWS_LWA_PORT=8080 \
    AWS_LWA_READINESS_CHECK_PATH=/health
EXPOSE 8080
CMD ["node", "server.mjs"]
