-- Step 1.5 follow-on — another real, pre-existing bug surfaced while
-- building Org Units & Groups, this time in migration 000's uuidv7()
-- reference implementation (already flagged there as "not the project's
-- own hardened production generator — swap it out before production use").
--
-- Found via class-validator: CreateOrgUnitDto's @IsUUID('7') rejected real
-- ids minted by the existing uuidv7() function. A UUID's RFC 9562 layout is
-- 16 bytes = 8-4-4-4-12 hex, where byte 6's high nibble carries the version
-- and byte 8's high 2 bits carry the variant (fixed "10"). The old function
-- built its "version + variant" 2-byte chunk from the first 2 bytes of its
-- random buffer and masked BOTH of them — but that whole 2-byte chunk
-- becomes uuid bytes 6-7 (i.e. hex group 3: "7xxx"), not bytes 6 AND 8. The
-- variant mask was landing on byte 7 (the second half of group 3, which
-- should be plain random) instead of byte 8 (the first half of group 4,
-- where the variant bits actually belong) — byte 8 was left fully random
-- and almost never happened to fall in the valid 8/9/a/b range.
--
-- Concretely, with the old function every id had a correct version nibble
-- ("...-7xxx-...") but an essentially random (usually invalid) variant
-- nibble on the FOLLOWING group ("...-7xxx-Yxxx-..." where Y was any hex
-- digit, not constrained to 8/9/a/b). Harmless to Postgres itself (uuid is
-- just 128 bits to it, version/variant conformance isn't enforced), but it
-- silently broke every RFC-conformant UUID validator pointed at an id from
-- this schema — class-validator's @IsUUID(), any frontend UUID library,
-- any future strict tooling.
--
-- Fix: move the variant mask from the second byte of the version chunk
-- (wrong) to the first byte of the following chunk (right). Same two
-- random-byte budget (10 bytes total, matching the original), same
-- timestamp handling — only the masking target changes.
--
-- NOT retroactive: every id minted by the old function (every row created
-- before this migration in this environment) keeps its already-assigned,
-- variant-noncompliant id forever — PKs don't get rewritten, and nothing
-- about the schema requires it. That's fine here: this is still pre-launch
-- MVP development with no real production data, which is exactly the
-- "swap it out before production use" window migration 000 already called
-- out — this is that swap, just narrower (one bit-placement fix, not the
-- full entropy/monotonicity hardening tracked separately).

CREATE OR REPLACE FUNCTION uuidv7()
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  unix_ts_ms   bytea;
  rand_bytes   bytea;
  group3       bytea; -- uuid bytes 6-7 ("Vxxx" hex group): version nibble + 12 random bits
  group4_and_5 bytea; -- uuid bytes 8-15 ("vxxx-xxxxxxxxxxxx"): variant bits + 70 random bits
  uuid_bytes   bytea;
BEGIN
  unix_ts_ms := substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3 FOR 6);
  rand_bytes := gen_random_bytes(10);

  -- byte 6 = version nibble (0111) + 4 random bits; byte 7 = fully random —
  -- NOT where the variant bits go (that was the bug).
  group3 := set_byte(substring(rand_bytes FROM 1 FOR 2), 0, (get_byte(rand_bytes, 0) & 15) | 112);

  -- byte 8 (first byte of this chunk) = variant bits (10) + 6 random bits;
  -- bytes 9-15 fully random.
  group4_and_5 := set_byte(substring(rand_bytes FROM 3 FOR 8), 0, (get_byte(rand_bytes, 2) & 63) | 128);

  uuid_bytes := unix_ts_ms || group3 || group4_and_5;

  RETURN encode(uuid_bytes, 'hex')::uuid;
END;
$$;
