/**
 * ESM resolve hook for the local dev server.
 *
 * Source files use `.js` import specifiers, which is what NodeNext and Vercel's
 * build both expect: Vercel compiles each `.ts` to a sibling `.js` without
 * rewriting specifiers. Node's `--experimental-strip-types` runs the `.ts`
 * files in place, so it needs the opposite mapping. This hook supplies it.
 */

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && specifier.endsWith(".js")) {
    try {
      return await nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    } catch {
      // No sibling .ts — fall through to the normal resolution below.
    }
  }
  return nextResolve(specifier, context);
}
