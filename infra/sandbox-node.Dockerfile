FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
RUN apk add --no-cache git=2.54.0-r0 python3=3.14.10-r1 py3-pip=26.1.2-r0 \
 && addgroup -S -g 10001 oda && adduser -S -D -H -u 10001 -G oda oda \
 && mkdir /workspace && chown oda:oda /workspace
USER 10001:10001
WORKDIR /workspace
ENV HOME=/tmp/oda-home npm_config_ignore_scripts=true
CMD ["node", "--version"]
