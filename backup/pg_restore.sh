psql -U postgres -f roles.sql
psql -U postgres -c "DROP DATABASE fitflex;"
psql -U postgres -tc "SELECT 1 FROM pg_database WHERE datname = 'fitflex';" | grep -q 1 || psql -U postgres -c "CREATE DATABASE fitflex;"
pg_restore -U postgres -h localhost -C -d fitflex -j 4 fitflex.dump

