export interface AppEnv {
  DB: D1Database;
  APP_PASSWORD_HASH?: string;
  SESSION_SECRET?: string;
}

export type AppContext = EventContext<AppEnv, string, Record<string, string>>;
