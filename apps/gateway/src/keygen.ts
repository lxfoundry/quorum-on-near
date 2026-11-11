// Prints a new credential key as a line for `.env`: `node src/keygen.ts >> .env`.
import { generateCredentialJwk } from './credential.ts';

const jwk = await generateCredentialJwk();
process.stdout.write(`QUORUM_CREDENTIAL_JWK=${JSON.stringify(jwk)}\n`);
