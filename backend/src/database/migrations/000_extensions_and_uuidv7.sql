-- Prerequisite for every table below: architecture/data-model.md's PKs all
-- default to uuidv7() so organization_id/id-leading indexes keep sequential
-- insert locality instead of random-order btree writes.
--
-- NOTE: this is a standard reference implementation, not the project's own
-- hardened production generator — swap it out before production use. See
-- this folder's README.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_bytes(), used below

CREATE OR REPLACE FUNCTION uuidv7()
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  unix_ts_ms  bytea;
  rand_bytes  bytea;
  uuid_bytes  bytea;
BEGIN
  unix_ts_ms := substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3 FOR 6);
  rand_bytes := gen_random_bytes(10);

  uuid_bytes := unix_ts_ms ||
    set_byte(
      set_byte(substring(rand_bytes FROM 1 FOR 2), 0,
        (get_byte(rand_bytes, 0) & 15) | 112), -- version 7
      1,
      (get_byte(rand_bytes, 1) & 63) | 128      -- variant 10
    ) ||
    substring(rand_bytes FROM 3 FOR 8);

  RETURN encode(uuid_bytes, 'hex')::uuid;
END;
$$;
