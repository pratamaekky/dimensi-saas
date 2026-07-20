// Min 8 chars, at least one lowercase, one uppercase, one special (non-alphanumeric) char.
export const STRONG_PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*[^A-Za-z0-9]).{8,}$/;

export const STRONG_PASSWORD_MESSAGE =
  'password minimal 8 karakter, harus mengandung huruf besar, huruf kecil, dan karakter spesial';
