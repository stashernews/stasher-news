#!/bin/sh
set -e

KEY_DIR="${1:-/keys}"
mkdir -p "$KEY_DIR"

openssl req -x509 -newkey rsa:2048 \
  -keyout "$KEY_DIR/lws.key" \
  -out "$KEY_DIR/lws.crt" \
  -days 3650 -nodes \
  -subj "/CN=monero-lws" \
  -addext "subjectAltName=DNS:monero-lws"
