# The operator deploy check's serverless fixture (MOTIR-9975): a small HTTP
# server run on Lambda through the Lambda Web Adapter, as MOTIR-5769 §3 names it.
# Build with `--build-arg RELEASE_LABEL=<label>`: the label is baked into a
# layer, so two labels are two digests and a second release is a real one.
FROM public.ecr.aws/docker/library/node:22-slim
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.1.0 /lambda-adapter /opt/extensions/lambda-adapter
WORKDIR /app
RUN npm install --no-save --no-package-lock --omit=dev pg@8.13.1
ARG RELEASE_LABEL
RUN test -n "$RELEASE_LABEL"
ENV MOTIR_FIXTURE_RELEASE=$RELEASE_LABEL \
    PORT=8080 \
    AWS_LWA_PORT=8080 \
    AWS_LWA_READINESS_CHECK_PATH=/health
COPY server.mjs ./
CMD ["node", "/app/server.mjs"]
