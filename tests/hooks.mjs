// Подменяет импорт '@vercel/blob' на заглушку из tests/blob.mjs.
const STUB = new URL('./blob.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === '@vercel/blob') return { url: STUB, shortCircuit: true };
  return next(specifier, context);
}
