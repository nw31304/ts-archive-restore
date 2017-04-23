export type PreparedStatement = string;

export interface DBConnection {
    host: string,
    port: number,
    database: string,
    user: string,
    password: string,
    number: number,
    schema: string
}

export interface LoggerConfig {
    directory: string,
    filename: string,
    level: string
}

export interface Config {
    pg_prefix: string,
    s3_bucket: string,
    logger: LoggerConfig,
    db_connection: DBConnection
}
