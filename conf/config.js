module.exports = {
    /**
     *  S3 bucket where report / analysis compressed dumps are stored
     *  The actual location is:
     *      ${s3_bucket}/${db_connection.database}/${db_connection.schema}/(analysis|report)_nnn.dump
     */
    "s3_bucket": "tomtomapac.com.trafficstats",
    /**
     *  Directory where pg_restore, pg_dump, and psql binaries are located
     */
    "pg_prefix": "/usr/local/bin",
    /**
     * Logging configuration 
     */
    "logger": {
        /**
         * Directory where the winston file transport logs its output
         */
        "directory": "logs",
        /**
         *  File name where logs are written
         */
        "filename": "trafficstats",
        /**
         * Logging level for both console and file log transports
         */
        "level": "debug"
    },
    /**
     * trafficstats DB configuration for pg_promise
     */
    "db_connection": {
        "host": "postgresql-production.cybpkfsrzrhy.ap-southeast-2.rds.amazonaws.com",
        "port": 5432,
        "database": "trafficstats_internal",
        "user": "postgres",
        "password": "p0st0ne",
        "number": 2,  // Number of connections in pool
        "schema": "public"
    }
}
