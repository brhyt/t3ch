FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1
WORKDIR /app
COPY broker.mjs /app/broker.mjs
USER 1000:1000
CMD ["node", "/app/broker.mjs"]
