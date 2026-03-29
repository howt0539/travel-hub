#!/bin/bash
cd "$(dirname "$0")" && npx wrangler pages deploy . --project-name trip-hub --branch main
