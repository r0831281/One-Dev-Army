FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
RUN addgroup -S -g 10001 oda && adduser -S -D -H -u 10001 -G oda oda
WORKDIR /app
USER 10001:10001
ENTRYPOINT ["node"]
CMD ["--version"]
