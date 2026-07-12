-- Keep the passcode hash and cookie generation in one row so verification,
-- conditional rotation and session invalidation share one atomic state unit.
CREATE TABLE auth_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL CHECK (length(trim(password_hash)) > 0),
  session_generation INTEGER NOT NULL DEFAULT 0 CHECK (session_generation BETWEEN 0 AND 9007199254740991),
  updated_at TEXT NOT NULL
);

-- Preserve existing deployments. The application uses the same one-row seed
-- after migration when APP_PASSWORD_HASH provisions a fresh database;
-- INSERT OR IGNORE makes concurrent seed attempts idempotent.
INSERT OR IGNORE INTO auth_state (id, password_hash, session_generation, updated_at)
SELECT
  1,
  json_extract(password.value_json, '$.hash'),
  CASE
    WHEN generation.value_json IS NOT NULL
      AND json_valid(generation.value_json)
      AND (
        (
          json_type(generation.value_json, '$') = 'integer'
          AND json_extract(generation.value_json, '$') >= 0
          AND json_extract(generation.value_json, '$') <= 9007199254740991
        )
        OR (
          json_type(generation.value_json, '$') = 'text'
          AND length(trim(json_extract(generation.value_json, '$'))) > 0
          AND trim(json_extract(generation.value_json, '$')) NOT GLOB '*[^0-9]*'
          AND CAST(json_extract(generation.value_json, '$') AS INTEGER) <= 9007199254740991
        )
      )
    THEN CAST(json_extract(generation.value_json, '$') AS INTEGER)
    ELSE 0
  END,
  password.updated_at
FROM app_settings AS password
LEFT JOIN app_settings AS generation ON generation.key = 'session_generation'
WHERE password.key = 'local_password_hash'
  AND json_valid(password.value_json)
  AND json_type(password.value_json, '$.hash') = 'text'
  AND length(trim(json_extract(password.value_json, '$.hash'))) > 0;

-- Keep the legacy rows current throughout a rolling deploy and after a code
-- rollback. The guarded UPSERTs terminate their own trigger cycle even when
-- SQLite recursive triggers are enabled.
CREATE TRIGGER app_settings_auth_hash_insert
AFTER INSERT ON app_settings
WHEN NEW.key = 'local_password_hash'
  AND json_valid(NEW.value_json)
  AND json_type(NEW.value_json, '$.hash') = 'text'
  AND length(trim(json_extract(NEW.value_json, '$.hash'))) > 0
BEGIN
  INSERT INTO auth_state (id, password_hash, session_generation, updated_at)
  VALUES (
    1,
    json_extract(NEW.value_json, '$.hash'),
    COALESCE(
      (
        SELECT CAST(json_extract(value_json, '$') AS INTEGER)
        FROM app_settings
        WHERE key = 'session_generation'
          AND json_valid(value_json)
          AND (
            (
              json_type(value_json, '$') = 'integer'
              AND json_extract(value_json, '$') BETWEEN 0 AND 9007199254740991
            )
            OR (
              json_type(value_json, '$') = 'text'
              AND length(trim(json_extract(value_json, '$'))) > 0
              AND trim(json_extract(value_json, '$')) NOT GLOB '*[^0-9]*'
              AND CAST(json_extract(value_json, '$') AS INTEGER) <= 9007199254740991
            )
          )
      ),
      0
    ),
    NEW.updated_at
  )
  ON CONFLICT(id) DO UPDATE SET
    password_hash = excluded.password_hash,
    updated_at = excluded.updated_at
  WHERE auth_state.password_hash IS NOT excluded.password_hash
     OR auth_state.updated_at IS NOT excluded.updated_at;
END;

CREATE TRIGGER app_settings_auth_hash_update
AFTER UPDATE OF value_json, updated_at ON app_settings
WHEN NEW.key = 'local_password_hash'
  AND json_valid(NEW.value_json)
  AND json_type(NEW.value_json, '$.hash') = 'text'
  AND length(trim(json_extract(NEW.value_json, '$.hash'))) > 0
BEGIN
  INSERT INTO auth_state (id, password_hash, session_generation, updated_at)
  VALUES (
    1,
    json_extract(NEW.value_json, '$.hash'),
    COALESCE(
      (
        SELECT CAST(json_extract(value_json, '$') AS INTEGER)
        FROM app_settings
        WHERE key = 'session_generation'
          AND json_valid(value_json)
          AND (
            (
              json_type(value_json, '$') = 'integer'
              AND json_extract(value_json, '$') BETWEEN 0 AND 9007199254740991
            )
            OR (
              json_type(value_json, '$') = 'text'
              AND length(trim(json_extract(value_json, '$'))) > 0
              AND trim(json_extract(value_json, '$')) NOT GLOB '*[^0-9]*'
              AND CAST(json_extract(value_json, '$') AS INTEGER) <= 9007199254740991
            )
          )
      ),
      0
    ),
    NEW.updated_at
  )
  ON CONFLICT(id) DO UPDATE SET
    password_hash = excluded.password_hash,
    updated_at = excluded.updated_at
  WHERE auth_state.password_hash IS NOT excluded.password_hash
     OR auth_state.updated_at IS NOT excluded.updated_at;
END;

CREATE TRIGGER app_settings_auth_generation_insert
AFTER INSERT ON app_settings
WHEN NEW.key = 'session_generation'
  AND json_valid(NEW.value_json)
  AND (
    (
      json_type(NEW.value_json, '$') = 'integer'
      AND json_extract(NEW.value_json, '$') BETWEEN 0 AND 9007199254740991
    )
    OR (
      json_type(NEW.value_json, '$') = 'text'
      AND length(trim(json_extract(NEW.value_json, '$'))) > 0
      AND trim(json_extract(NEW.value_json, '$')) NOT GLOB '*[^0-9]*'
      AND CAST(json_extract(NEW.value_json, '$') AS INTEGER) <= 9007199254740991
    )
  )
BEGIN
  UPDATE auth_state
  SET session_generation = CAST(json_extract(NEW.value_json, '$') AS INTEGER),
      updated_at = NEW.updated_at
  WHERE id = 1
    AND (
      session_generation IS NOT CAST(json_extract(NEW.value_json, '$') AS INTEGER)
      OR updated_at IS NOT NEW.updated_at
    );
END;

CREATE TRIGGER app_settings_auth_generation_update
AFTER UPDATE OF value_json, updated_at ON app_settings
WHEN NEW.key = 'session_generation'
  AND json_valid(NEW.value_json)
  AND (
    (
      json_type(NEW.value_json, '$') = 'integer'
      AND json_extract(NEW.value_json, '$') BETWEEN 0 AND 9007199254740991
    )
    OR (
      json_type(NEW.value_json, '$') = 'text'
      AND length(trim(json_extract(NEW.value_json, '$'))) > 0
      AND trim(json_extract(NEW.value_json, '$')) NOT GLOB '*[^0-9]*'
      AND CAST(json_extract(NEW.value_json, '$') AS INTEGER) <= 9007199254740991
    )
  )
BEGIN
  UPDATE auth_state
  SET session_generation = CAST(json_extract(NEW.value_json, '$') AS INTEGER),
      updated_at = NEW.updated_at
  WHERE id = 1
    AND (
      session_generation IS NOT CAST(json_extract(NEW.value_json, '$') AS INTEGER)
      OR updated_at IS NOT NEW.updated_at
    );
END;

CREATE TRIGGER auth_state_legacy_insert
AFTER INSERT ON auth_state
WHEN NEW.id = 1
BEGIN
  INSERT INTO app_settings (key, value_json, updated_at)
  VALUES ('local_password_hash', json_object('hash', NEW.password_hash), NEW.updated_at)
  ON CONFLICT(key) DO UPDATE SET
    value_json = excluded.value_json,
    updated_at = excluded.updated_at
  WHERE app_settings.value_json IS NOT excluded.value_json
     OR app_settings.updated_at IS NOT excluded.updated_at;

  INSERT INTO app_settings (key, value_json, updated_at)
  VALUES ('session_generation', CAST(NEW.session_generation AS TEXT), NEW.updated_at)
  ON CONFLICT(key) DO UPDATE SET
    value_json = excluded.value_json,
    updated_at = excluded.updated_at
  WHERE app_settings.value_json IS NOT excluded.value_json
     OR app_settings.updated_at IS NOT excluded.updated_at;
END;

CREATE TRIGGER auth_state_legacy_update
AFTER UPDATE OF password_hash, session_generation, updated_at ON auth_state
WHEN NEW.id = 1
BEGIN
  INSERT INTO app_settings (key, value_json, updated_at)
  VALUES ('local_password_hash', json_object('hash', NEW.password_hash), NEW.updated_at)
  ON CONFLICT(key) DO UPDATE SET
    value_json = excluded.value_json,
    updated_at = excluded.updated_at
  WHERE app_settings.value_json IS NOT excluded.value_json
     OR app_settings.updated_at IS NOT excluded.updated_at;

  INSERT INTO app_settings (key, value_json, updated_at)
  VALUES ('session_generation', CAST(NEW.session_generation AS TEXT), NEW.updated_at)
  ON CONFLICT(key) DO UPDATE SET
    value_json = excluded.value_json,
    updated_at = excluded.updated_at
  WHERE app_settings.value_json IS NOT excluded.value_json
     OR app_settings.updated_at IS NOT excluded.updated_at;
END;
