import type { User } from './types.ts';

/** Response for a successful register or login. */
export interface AuthResponse {
  user: User;
  /** Raw session token, for API clients that authenticate via `Authorization: Bearer`. */
  token: string;
}

/** Response for `GET /api/v1/auth/me`. */
export interface MeResponse {
  user: User;
  /** Effective permissions as a decimal bitfield string. */
  permissions: string;
}

/** Consistent error body returned by every API endpoint. */
export interface ApiErrorBody {
  error: { code: string; message: string };
}
