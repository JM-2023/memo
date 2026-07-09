export interface AppEnv {
  DB: D1Database;
  APP_PASSWORD_HASH?: string;
  SESSION_SECRET?: string;
  /** 64 hex chars (32 bytes). Present = memo content is sealed at rest. */
  MEMO_ENC_KEY?: string;
}

export type AppContext = EventContext<AppEnv, string, Record<string, string>>;
