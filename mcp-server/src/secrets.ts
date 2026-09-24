/** Compare two secrets by digest, so the comparison does not short-circuit on the first byte. */
export async function secretsMatch(left: string, right: string): Promise<boolean> {
  const digest = async (value: string): Promise<string> => {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  };
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  return a === b;
}
