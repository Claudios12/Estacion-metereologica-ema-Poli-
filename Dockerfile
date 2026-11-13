# Poli Clima — imagen mínima: sin dependencias externas, solo Node.js y dos archivos.
FROM node:24-slim

WORKDIR /app
COPY package.json server.mjs index.html ./
COPY scripts ./scripts

# La base de datos vive en un volumen para que sobreviva a reinicios y actualizaciones de la imagen.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

ENV PORT=8080 \
    HOST=0.0.0.0 \
    DB_FILE=/data/poli-clima.db \
    LOG_LEVEL=info

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
