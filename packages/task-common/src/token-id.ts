// Client-generated token identifiers.
//
// Neither token-creation endpoint returns the id it assigned -- both respond with the JWT
// and nothing else. The argocd CLI recovers the id by parsing the JWT unverified, which is
// avoidable: the API accepts an explicit `id`, so generating one here means the handle for
// revocation is known without ever decoding a token.

import * as crypto from 'node:crypto';

export function newTokenId(): string {
    return crypto.randomUUID();
}
