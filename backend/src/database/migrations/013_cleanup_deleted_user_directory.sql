-- 2026-10-07 — data fix accompanying the UsersService.remove() change.
--
-- Deleting a user used to leave their control.user_directory row behind.
-- That row's email is the table's PRIMARY KEY, so once the deleted user's
-- mailbox was also deleted, creating a new account at the same address failed
-- with a raw unique-violation 500. remove() now deletes the row; this cleans
-- up rows already left behind by earlier deletions. Safe to re-run.

DELETE FROM control.user_directory ud
USING tenant.users u
WHERE u.id = ud.user_id
  AND u.status = 'deleted';
