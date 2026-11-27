# Build from the repository root. CI can reuse the already verified Maven artifact.
ARG RELAY_BUILD=source
FROM node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752 AS node
FROM maven:3.9.9-eclipse-temurin-21@sha256:3a4ab3276a087bf276f79cae96b1af04f53731bec53fb2e651aca79e4b10211e AS compile
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /opt/npm
WORKDIR /src
COPY package.json package-lock.json .npmrc ./
COPY scripts/prepare.mjs scripts/prepare.mjs
RUN --mount=type=cache,target=/root/.npm STUDYHUB_SKIP_PREPARE=1 node /opt/npm/bin/npm-cli.js ci --no-audit --no-fund
COPY . .
RUN --mount=type=cache,target=/root/.m2/repository mvn -B -ntp -f packages/studyhub-spring/pom.xml \
    -pl studyhub-sync-api -am -DskipTests clean package && cp packages/studyhub-spring/studyhub-sync-api/target/*-relay.jar /relay.jar
FROM scratch AS source
COPY --from=compile /relay.jar /relay.jar
FROM node AS prebuilt
COPY packages/studyhub-spring/pom.xml /candidates/pom.xml
COPY packages/studyhub-spring/studyhub-sync-api/target/*-relay.jar /candidates/
RUN node -e "const fs=require('node:fs');const v=fs.readFileSync('/candidates/pom.xml','utf8').match(/<artifactId>studyhub-spring<\/artifactId>\s*<version>([^<]+)<\/version>/)[1];fs.copyFileSync('/candidates/studyhub-sync-api-'+v+'-relay.jar','/relay.jar')"
FROM ${RELAY_BUILD} AS artifact
FROM eclipse-temurin:21-jdk-alpine-3.23@sha256:28122dc4b448e4ab15633fc8b7c10e52841015ffe4272fe70bc1a7404053a579 AS runtime
RUN jlink --add-modules java.base,java.logging,java.naming,java.management,java.net.http,java.security.jgss,java.sql,java.xml,java.desktop,java.instrument,jdk.crypto.ec,jdk.unsupported,jdk.management \
    --strip-debug --no-header-files --no-man-pages --compress=2 --output /opt/studyhub-jre
FROM alpine:3.23@sha256:469c9ea410b9215eaee7976ba6c0639039b444be8e5d638f7abbada189971eb2
RUN apk add --no-cache libstdc++ zlib && addgroup -g 10001 studyhub && adduser -DH -u 10001 -G studyhub studyhub && mkdir -p /data && chown studyhub:studyhub /data
COPY --from=runtime /opt/studyhub-jre /opt/java
COPY --from=artifact /relay.jar /opt/studyhub/relay.jar
ENV SERVER_ADDRESS=0.0.0.0 SERVER_PORT=8080 STUDYHUB_SYNC_DATA_DIR=/data
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --start-period=20s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8080/actuator/health || exit 1
ENTRYPOINT ["/opt/java/bin/java", "--enable-preview", "-jar", "/opt/studyhub/relay.jar"]
