FROM danifernandezs/skopeo:1.41.0-alpine3.10.3

RUN apk add --no-cache curl
RUN cd /usr/local/bin && \
  curl -O https://amazon-ecr-credential-helper-releases.s3.us-east-2.amazonaws.com/0.4.0/linux-amd64/docker-credential-ecr-login && \
  chmod +x docker-credential-ecr-login
