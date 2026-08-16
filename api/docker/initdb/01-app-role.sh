#!/bin/sh
# Creates the LOGIN role the API connects as, locally.
#
# Runs once, on first container start, before any migration. The migration
# (0001) creates `avo_app` NOLOGIN if it is absent and then applies the grants
# and the REVOKEs — so in production a DBA provisions this role with a real
# secret and the migration only ever touches privileges, never passwords.
#
# The point of a separate role: `avo_app` does not own the tables. An owner can
# UPDATE its own table no matter what has been revoked, which would make the
# append-only guarantee on audit_log decorative.

set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	DO \$\$
	BEGIN
	  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'avo_app') THEN
	    CREATE ROLE avo_app LOGIN PASSWORD '${APP_DB_PASSWORD}';
	  END IF;
	END
	\$\$;

	GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO avo_app;
EOSQL
