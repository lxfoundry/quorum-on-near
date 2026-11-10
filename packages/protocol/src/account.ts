/** NEAR's account id rule: lowercase parts joined by `.`, each part letters and digits joined by `-` or `_`. */
const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** True when `value` is a valid NEAR account id (named or implicit), 2 to 64 characters long. */
export function isAccountId(value: string): boolean {
  return value.length >= 2 && value.length <= 64 && ACCOUNT_ID.test(value);
}
