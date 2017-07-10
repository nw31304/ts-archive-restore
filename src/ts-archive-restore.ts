/**
 * Library to archive and restore trafficstats DB objects to/from S3. The
 * exported functions are:
 *
 * archiveReport(id) - Archive all DB objects associated with report id
 * restoreReport(id) - Restore all DB objects associated with report id
 * restoreAnalysis(id) - Restore all DB objects associated with analysis id
 *
 * All of the above functions return Promises that resolve/reject when the
 * corresponding action is completed.
 *
 * Notice there is no exported archiveAnalysis(n). This is because an analysis
 * will be implicitly archived as soon as one of the reports upon which it
 * depends is archived. Also, if any of the reports needed by an analysis are
 * archived when the analysis is restored, they will be implicitly restored as
 * part if the analysis restoral.
 *
 * The configuration is driven by "config.js" in the ../conf directory.
 * Comments therein explain the settings. Key is the directory for the
 * postgresql binaries as well as the DB configuration paramters describing how
 * to connect to the trafficstats DB.
 *
 * tsconfig.json may need to be tweaked to cause typescript to generate JS
 * appropriate for the node version.
 *
 * To compile the typescript source to javascript, execute:
 *
 * ./node_modules/typescript/bin/tsc
 *
 * from the app directory.
 */


import tmp = require("tmp");
import aws = require('aws-sdk');
import fs = require('fs');
import _ = require('lodash');
import { Sails, Config, PreparedStatement, DBConnection } from "./types";
declare var sails: Sails
//const config: Config = require("../conf/config.js");
const config = sails.config.archiveRestoreConfig

const exec = require('child_process').exec;
import * as pgPromise from 'pg-promise';
var pgp: pgPromise.IMain = pgPromise();
let squel = require("squel").useFlavour("postgres");
const logger = require("./logger")();

export class AlreadyArchivedOrDoesNotExistError extends Error {}

/**
  Prepared statement to reset the S3 location of an un-archived report

  @param{any} $1 - new archive_location (should be null)
  @param{any} $2 - new archive timestamp (should be null)
  @param{number} $3 - report id
  */
let reset_report_s3_location_sql: PreparedStatement = squel.update()
    .table(`${config.db_connection.schema}.report`)
    .set("archive_location", null)
    .set("archive_timestamp", null)
    .set("restore_timestamp", "now()")
    .where("id=?")
    .toParam()
    .text;

/**
  Prepared statement to reset the S3 location of an un-archived analysis

  @param{any} $1 - new archive_location (should be null)
  @param{any} $2 - new archive timestamp (should be null)
  @param{number} $3 - analysis id
  */
let reset_analysis_s3_location_sql: PreparedStatement = squel.update()
    .table(`${config.db_connection.schema}.analysis`)
    .set("archive_location", null)
    .set("archive_timestamp", null)
    .set("restore_timestamp", "now()")
    .where("id=?")
    .toParam()
    .text;

/**
  Select used to validate that an analysis has not been archived.            

  @param{number} $1 - analysis id
  */
let validate_analysis_archived_sql: PreparedStatement = squel.select()
    .from(`${config.db_connection.schema}.analysis`)
    .field("archive_location")
    .where(
    squel.expr()
        .and("archive_location is not null")
        .and("id=?")
    )
    .toParam()
    .text;

/**
  Select used to validate that a report has not been archived.            

  @param{number} $1 - report id
  */
let validate_report_present_sql: PreparedStatement = squel.select()
    .from(`${config.db_connection.schema}.report`)
    .field("archive_location")
    .where(
    squel.expr()
        .and("archive_location is null")
        .and("id=?")
    )
    .toParam()
    .text;

/**
  Prepared statement to retrieve the S3 location of an archived analysis

  @param{number} $1 - analysis id
  */
let analysis_s3_location_sql: PreparedStatement = squel.select()
    .from(`${config.db_connection.schema}.analysis`)
    .field("archive_location")
    .where(
    squel.expr()
        .and("archive_location is not null")
        .and("id=?")
    )
    .toParam()
    .text;

/**
  Prepared statement to retrieve the S3 location of an archived report

  @param{number} $1 - report id
  */
let report_s3_location_sql: PreparedStatement = squel.select()
    .from(`${config.db_connection.schema}.report`)
    .field("archive_location")
    .where(
    squel.expr()
        .and("archive_location is not null")
        .and("id=?")
    )
    .toParam()
    .text;

/**
  Prepared statement to retrieve all non-archived analysis ids dependent upon
  a given report id.

  @param{number} $1 - report id
  */
let analyses_by_report_sql: PreparedStatement = squel.select()
    .from(`${config.db_connection.schema}.analysis_report`, "j")
    .field("j.analysis")
    .distinct()
    .join(`${config.db_connection.schema}.analysis`, "a", "j.analysis = a.id")
    .where(
    squel.expr()
        .and("a.archive_location is null")
        .and("j.report=?")
    )
    .toParam()
    .text;

/** 
  Prepared statement to retrieve all archived reports upon which
  a given analysis depends.

  @param{number} $1 - analysis id
  */
let reports_by_analysis_sql: PreparedStatement = squel.select()
    .from(`${config.db_connection.schema}.analysis_report`, "j")
    .field("report")
    .distinct()
    .join(`${config.db_connection.schema}.report`, "r", "j.report = r.id")
    .where(
    squel.expr()
        .and("r.archive_location is not null")
        .and("j.analysis=?")
    )
    .toParam()
    .text;

/**
 * alter table analysis add column archive_location text default null;
 * alter table analysis add column archive_timestamp timestamp with time zone default null;
 * alter table report add column archive_location text default null;
 * alter table report add column archive_timestamp timestamp with time zone default null;
 */
let s3: aws.S3 = new aws.S3();
let db = pgp(config.db_connection);
type DBType = typeof db;
let connectStr: string = `postgresql://${config.db_connection.user}:${config.db_connection.password}@${config.db_connection.host}:${config.db_connection.port}/${config.db_connection.database}`

/**
 * Return the S3 location of an archived report or analysis
 * 
 * @param{DBType} db - pg-promise DB instance to use
 * @param{number} id - Key of report/analysis whose location is to be returned
 * @param{PreparedStatement} query - String containing parameterized statement to execute
 * @return{Promise<string>} Promise resolved with a string containing the S3 object name
 */
function get_s3_location(db: DBType, id: number, ps: PreparedStatement): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        logger.debug(() => ["Retrieving s3 location of report/analysis %d", id]);
        db.one(ps, id)
            .then(r => {
                logger.debug(() => ["S3 location of report/analysis %d is %s", id, r.archive_location]);
                resolve(r.archive_location)
            })
            .catch(err => {
                logger.warn(() => ["Error retrieving s3 location of report/analysis %d: %s", id, err]);
                reject(`Unable to locate S3 location for report/analysis ${id}.  Is it actually archived?: ${err}`)
            })
    })
}

/**
 * Return the S3 location of an archived report. Partially applied get_s3_location().
 * 
 * @param{DBType} db - pg-promise DB instance to use
 * @param{number} id - Key of report whose location is to be returned
 * @return{Promise<string>} Promise resolved with a string containing the S3 object name
 */
let get_report_s3_location: (DBType, number) => Promise<string> = _.partialRight(get_s3_location, report_s3_location_sql);

/**
 * Return the S3 location of an archived analysis. Partially applied get_s3_location().
 * 
 * @param{DBType} db - pg-promise DB instance to use
 * @param{number} id - Key of analysis whose location is to be returned
 * @return{Promise<string>} Promise resolved with a string containing the S3 object name
 */
let get_analysis_s3_location: (DBType, number) => Promise<string> = _.partialRight(get_s3_location, analysis_s3_location_sql);

/**
 * Return a promise resolved when the specified file containing a compressed
 * dump created by pg_dump is restored to Postgres
 * 
 * @param{string} fn - path to filename containing compressed dump to restore
 * @return{Promise<string>} Promise resolved when the specified dump has been restored
 */
function restore(fn: string): Promise<string> {
    return new Promise((resolve, reject) => {
        logger.info(() => ["Initiating pg_restore of %s", fn]);

        exec(`${config.pg_prefix}/pg_restore -c -Fc ${fn} | ${config.pg_prefix}/psql --dbname ${connectStr}`, (error, stdout, stderr) => {
            if (error) {
                logger.warn(() => ["Error attempting pg_restore of %s: %s", fn, error]);
                reject(error);
            } else {
                logger.debug(() => ["pg_restore of %s completed", fn]);
                resolve(fn);
            }
        });
    })
}

/**
 * Return a promise resolved when the DDL/SQL commands contained in
 * the passed string are executed.
 * 
 * @param{string} cmds - string of commands to execute, delimited with ";"
 * @return{Promise} Promise resolved when the specified dump has been restored
 * 
 */
function execDBCmds(cmds: string): Promise<{}> {
    return new Promise((resolve, reject) => {
        logger.debug(() => ["Initiating execution of DB commands"]);
        exec(`${config.pg_prefix}/psql -c "${cmds}" --dbname ${connectStr} `, (error, stdout, stderr) => {
            if (error) {
                logger.warn(() => ["Error executing DB commands: %s", error]);
                reject(error);
            } else {
                logger.debug(() => ["Execution of DB commands complete successfully"]);
                resolve({});
            }
        });
    })
}

/**
 * Find all archived report ids upon which the specified analysis id depends
 * 
 * @param{DBType} db - pg-promise IDatabase instance
 * @param{number} analysis_id - DB key of analysis
 * @returns{Promise} Promise resolved with an array of archived report ids
 * 
 */
function getNeededReports(db: DBType, analysis_id: number): Promise<number[]> {

    return new Promise((resolve, reject) => {
        logger.debug(() => ["Retrieving reports needed by analysis: %d", analysis_id]);
        db.any(reports_by_analysis_sql, analysis_id)
            .then((r) => {
                let results: number[] = r.map((row) => row.report);
                logger.debug(() => ["%d reports referenced by analysis %d", results.length, analysis_id]);
                resolve(results);
            })
            .catch((err) => {
                logger.warn(() => ["Error retrieving reports associated with analysis %d: %s", analysis_id, err]);
                reject(err)
            })
    })
}


/**
 * Find all non-archived analysis ids that depend on the specified report id
 * 
 * @param{DBType} db - pg-promise IDatabase instance
 * @param{number} report_id - DB key of report
 * @returns{Promise} Promise resolved with an array of non-archived analysis ids
 */
function getDependentAnalyses(db: DBType, report_id: number): Promise<number[]> {

    return new Promise((resolve, reject) => {
        logger.debug(() => ["Retrieving analyses refercing report %d", report_id]);
        db.any(analyses_by_report_sql, report_id)
            .then((r) => {
                let results: number[] = r.map((row) => row.analysis);
                logger.debug(() => ["%d non-archived analyses reference report %d", results.length, report_id]);
                resolve(results);
            })
            .catch((err) => {
                logger.warn(() => ["Error retrieving analyses associated with report %s: %s", report_id, err]);
                reject(err)
            })
    })
}


/**
 * Map each report id in the argument array to a Promise resolved when the DB
 * objects associated with the report have been restored
 * 
 * @param{number[]} ids - array of reports ids to be restored
 * @returns{Promise} Promise resolved when all reports have been restored
 */
function restoreReports(ids: number[]): Promise<string[]> {
    let ps: Promise<string>[] = ids.map((id) => restoreReport(id));
    return Promise.all(ps);
}

/**
 * Map each analysis id in the argument array to a Promise resolved when the DB
 * objects associated with the analysis have been dumped and archived to S3
 * 
 * @param{number[]} ids - array of analysis ids to be archived
 * @returns{Promise} Promise resolved with an array of strings of cmds to 
 *                   execute to clean the DB of the corresponding analysis
 */
function archiveAnalyses(ids: number[]): Promise<string[]> {
    let ps: Promise<string>[] = ids.map((id) => archiveAnalysis(id));
    return Promise.all(ps);
}

/**
 * Return a Promise resolved when a temporary file name is generated
 * @return{string} pathname of temporary file name
 */
function generateTmpFile(): Promise<string> {
    return new Promise((resolve, reject) => {
        tmp.tmpName(function _tempNameGenerated(err, path) {
            if (err) {
                reject(err);
            } else {
                resolve(path);
            }
        });
    })
}


/**
 * Returns a promise resolved when the specified analysis or report in
 * pg_dump'ed to the temporary file whose name is provided.
 * 
 * @param{string} fn - path to file to contain dump of specified objects
 * @param{string} objs -space delimied string ob objects to be dumped
 * @return{Promise} Promise resolved when dump is complete
 */
function dump(fn: string, objs: string): Promise<string> {
    return new Promise((resolve, reject) => {
        logger.debug(() => ["Dumping %s to %s", objs, fn]);
        exec(`${config.pg_prefix}/pg_dump -f ${fn} -c -Fc ${objs} --dbname ${connectStr} `, (error, stdout, stderr) => {
            if (error) {
                logger.debug(() => ["Error dumping %s to %s successful", objs, fn]);
                reject(error);
            } else {
                logger.debug(() => ["Dump of %s to %s successful", objs, fn]);
                resolve(fn);
            }
        });
    })
}


/**
 * Returns a promise resolved when the specified analysis in pg_dump'ed to the
 * specified temporary file. Just a wrapper around the dump function.
 * 
 * @param{number} a - key of analysis to be dumped
 * @param{string} fn - pathname to temporary file to contain the dump
 */
function dumpAnalysis(a: number, fn: string): Promise<string> {
    let objs: string = `-t "${config.db_connection.schema}.analysis_${a}_*"`;
    return dump(fn, objs);
}


/**
 * Returns a promise resolved when the specified report in pg_dump'ed to the
 * specified temporary file. Just a wrapper around the dump function.
 * 
 * @param{number} r - id of report to be dumped
 * @param{string} fn - pathname to file to contain dump
 * @return{Promise} Promise resolved when dump of reort is complete
 */
function dumpReport(r: number, fn: string): Promise<string> {
    let objs: string = `-t "${config.db_connection.schema}.segment_${r}" -t "${config.db_connection.schema}.stats_${r}_*"`;
    return dump(fn, objs);
}


/**
 * Return a promise resolved with a list of DB object clean commands from the
 * specified compressed pg_dump archive
 * 
 * @param{string} fn - path to file containing compressed pg_dump
 * @return{Promise} Promise resolved with string of clean commands from dump
 */
function getCleanCommands(fn: string): Promise<string> {

    return new Promise((resolve, reject) => {
        logger.debug(() => ["Retrieving clean commands from dump in $s", fn]);
        exec(`${config.pg_prefix}/pg_restore -Fc -c ${fn} | awk '/^DROP/ { print $0} /ALTER TABLE .* DROP .*/ { print $0} '`, (error, stdout, stderr) => {
            if (error) {
                logger.warn(() => ["Error retrieving clean commands from %s", fn]);
                reject(error);
            } else {
                logger.debug(() => ["Clean commands successfully retrieved from %s", fn]);
                resolve(stdout.toString());
            }
        });
    })
}


/**
 * Return a Promise resolved when the specified file is deleted
 * 
 * @param{string} fn - pathname of file to be removed
 * @return{Promise} Promise resolved when specified file has been removed
 */
function removeFile(fn: string): Promise<{}> {
    return new Promise((resolve, reject) => {
        logger.debug(() => ["Removing file: %s", fn]);

        fs.unlink(fn, err => {
            if (err) {
                logger.debug(() => ["Removal of file %s failed: %s", fn, err]);
                reject(err);
            } else {
                logger.debug(() => ["Removal of file %s successful", fn]);
                resolve();
            }
        });
    });
}


/**
 * Return a promise resolved when the specified S3 bucket and key is downloaded
 * and stored in the specified path
 * 
 * @param{string} fn - file to contain requested bucket contents
 * @param{string} bucket - AWS S3 bucket
 * @param{string} key - AWS S3 key
 * @return{Promise} Promise resolved when S3 object has been stored into the
 *                  target file.
 */
function download(fn: string, bucket: string, key: string): Promise<{}> {
    return new Promise((resolve, reject) => {
        logger.debug(() => ["Initiaing download of S3 object %s/%s to %s", bucket, key, fn]);

        s3.getObject({
            'Bucket': bucket,
            'Key': key
        }, (err, data) => {
            if (err) {
                logger.warn(() => ["Error downloading bucket %s and key %s from AWS S3", bucket, key]);
                reject(err);
            } else {
                fs.writeFile(fn, data.Body, (err, data) => {
                    if (err) {
                        logger.warn(() => ["Download of S3 object %s/%s to %s failed: %s", bucket, key, fn, err]);
                        reject(err);
                    } else {
                        logger.debug(() => ["Download of S3 object %s/%s to %s successful", bucket, key, fn]);
                        resolve()
                    }
                })
            }
        })
    })
}


/**
 * Return a promise resolved when the specified file is transferred to 
 * the given S3 bucket and key
 * 
 * @param{string} fn - file to be uploaded
 * @param{string} bucket - AWS S3 bucket
 * @param{string} key - AWS S3 key
 * @return{Promise} Promise resolved when file has been uploaded to the S3 object
 */
function upload(fn: string, bucket: string, key: string): Promise<string> {
    return new Promise((resolve, reject) => {
        logger.debug(() => ["Initiaing upload of S3 object %s/%s from %s", bucket, key, fn]);
        let opts = {
            flags: 'r',
            encoding: null,
            fd: null,
            mode: 0o666,
            autoClose: true
        }
        let stream = fs.createReadStream(fn, opts);
        s3.upload({
            'Bucket': bucket,
            'Key': key,
            'Body': stream
        }, {
                partSize: 10 * 1024 * 1024,
                queueSize: 1
            }, (err, data) => {
                if (err) {
                    logger.warn(() => ["Upload of S3 object %s/%s from %s failed: %s", bucket, key, fn, err]);
                    reject(err);
                } else {
                    logger.debug(() => ["Upload of S3 object %s/%s from %s successful", bucket, key, fn]);
                    resolve(`${data.Bucket}/${data.Key}`);
                }
            });
    });
}


/**
 * Wrapper around upload that gives a key name specific to analysis dumps
 * 
 * @param{number} a - ID of analysis to be dumped
 * @param{string} fn - pathname of file containing dump of the analysis
 * @return{Promise} Promise resolved when the analysis dump has been uploaded to S3.
 */
function uploadAnalysisDump(a: number, fn: string): Promise<string> {
    return upload(fn, config.s3_bucket, `${config.db_connection.database}/${config.db_connection.schema}/analysis_${a}.dump`);
}


/**
 * Wrapper around upload that gives a key name specific to report dumps
 * 
 * @param{number} r - ID of report to be dumped
 * @param{string} fn - pathname of file containing dump of the report
 * @return{Promise} Promise resolved when the report dump has been uploaded to S3.
 */
function uploadReportDump(r: number, fn: string): Promise<string> {
    return upload(fn, config.s3_bucket, `${config.db_connection.database}/${config.db_connection.schema}/report_${r}.dump`);
}


/**
 * Return a Promise resolved when the specified analysis is archived to S3.
 * The promise is resolved with a string full of SQL that removes the DB
 * objects associated with the analysis as well as a statement which sets the
 * status of the analysis to "archived"
 * 
 * @param{number} id - id of analysis to be archived
 * @return{Promise} Promise resolved when the specified analysis is archived to S3.
 *                  The Promise is resolved with a semicolon delimited string of 
 *                  commands that remove all traces of the analysis from the DB
 */
export function archiveAnalysis(id: number): Promise<string> {
    return new Promise((resolve, reject) => {
        logger.info(() => ["Initiaing archive of analysis: %d", id]);

        let tmpFile: string | null = null;
        let cleanCommands: string;
        let s3Location;
        // First, generate a temp file to hold the dump
        generateTmpFile()
            .then(fn => {
                // Save the temp file name name and pg_dump all DB objects
                // associated with the specified analysis to that temporary
                // file
                tmpFile = fn;
                logger.debug(() => ["temporary file for dump", fn]);
                return dumpAnalysis(id, tmpFile);
            })
            .then(() => {
                // Transfer the dump file to S3
                logger.debug(() => ["Dump completed"]);
                return uploadAnalysisDump(id, tmpFile)
            })
            .then(url => {
                s3Location = url;
                logger.debug(() => ["Dump uploaded to %s", s3Location]);

                // Inspect the dump for the SQL statements needed to drop the
                // objects associated with the specified analysis
                return getCleanCommands(tmpFile)
            })
            .then(cmds => {
                // Save the DB clean SQL along with a statement that sets the
                // state of the analysis to "archived". Then remove the
                // temporary file.
                cleanCommands = cmds + `update ${config.db_connection.schema}.analysis set archive_location='${s3Location}',restore_timestamp=null,archive_timestamp=now() where id=${id};\n`;
                logger.debug(() => ["Commands to clean DB of analysis id %d: %s", id, cleanCommands]);
                return removeFile(tmpFile)
            })
            .then(() => {
                // Resolve this Promise with the SQL statements needed to clean
                // the DB of this analysis and set the state to "archived"
                logger.debug(() => ["Temporary file removed"]);
                resolve(cleanCommands)
            })
            .catch(err => {
                reject(err);
            })
            .then(() => {
                if (!_.isNil(tmpFile)) {
                    fs.unlinkSync(tmpFile);
                }
            })
    })
}

/**
 * Return a Promise resolved when the specified analysis is restored.      
 * First, check that the analysis is actually archived, and if it, first 
 * restore all reports upon which it depends.  Next, retrieve
 * the S3 bucket name where the compressed dump is stored.  Next, retrieve
 * the dump from S3 and restore it. Finally, update the database to reflect
 * the fact that the analysis is no longer archived.
 * 
 * @param{number} id - key of analysis to be restored
 * @return{Promise} Promise resolved when specified report has been restored 
 */
export function restoreAnalysis(id: number): Promise<{}> {
    return new Promise<{}>((resolve, reject) => {
        let tmpFile: string | null = null;
        logger.info(() => ["Initiating restore of analysis %d", id]);
        // Validate that the analysis is archived to S3
        db.one(validate_analysis_archived_sql, id)
            .then(() => {
                // Archive is archived to S3.  Get a list of reports this analysis needs.
                logger.debug(() => ["Analysis %d is archived. Finding needed reports"]);
                return getNeededReports(db, id)
            })
            .catch((err) => {
                // Analysis either soesn't exist or is not archived
                let errMsg = `Analysis ${id} either does not exist or is not archived. Error: ${err}`;
                logger.warn(() => [errMsg]);
                throw new Error(errMsg);
            })
            .then((deps) => {
                // Restore any archived reports needed by this analysis
                logger.debug(() => ["List of needed reports retrieved: %s", JSON.stringify(deps)]);
                return restoreReports(deps);
            })
            .then(() => {
                // Get a temporary file to hold the s3 object
                logger.debug(() => ["All reports needed by analysis %d restored", id]);
                return generateTmpFile()
            })
            // Retrieve the S3 location of the report
            .then(fn => {
                logger.debug(() => ["Temporary file for restore: %s", fn]);
                tmpFile = fn;
                return get_analysis_s3_location(db, id);
            })
            // Retrieve report's compressed dump from S3 and store it in the temp file
            .then((s3loc) => {
                logger.debug(() => ["S3 location of analysis %d: %s", id, s3loc]);
                let firstSlashPos = s3loc.indexOf('/');
                if (firstSlashPos <= 0 || firstSlashPos === s3loc.length - 1) {
                    let msg = `Unable to determine bucket and key from s3location: ${s3loc}`;
                    logger.warn(() => [msg]);
                    reject(msg);
                }
                return download(tmpFile, s3loc.substr(0, firstSlashPos), s3loc.substr(firstSlashPos + 1));
            })
            // Restore the compressed dump using pg_restore
            .then(() => {
                logger.debug(() => ["Download of dump object successful. Initiating restore"]);
                return restore(tmpFile);
            })
            // Remove the temporary file containing the compressed dump
            .then(() => {
                logger.debug(() => ["Restore successful. Removing temporary file"]);
                return removeFile(tmpFile);
            })
            // Reset the "archive_location" and "archive_timestamp" in the report table to null,
            // indicating that the report is present in the DB
            .then(() => {
                logger.debug(() => ["Temporary file removal successful. Resetting archive columns in DB"]);
                tmpFile = null;
                return db.none(reset_analysis_s3_location_sql, [null, null, "now()", id])
            })
            // Restore complete
            .then(() => {
                logger.debug(() => ["DB update successful. Restore of analysis %d complete", id]);
                resolve();
            })
            // Log the failure message and reject the restore promise
            .catch(err => {
                logger.warn(() => ["Error restoring analysis %d: %s", id, err]);
                reject(err)
            })
    })
}

/**
 * Return a Promise resolved when the specified report is restored.      
 * First, check that the report is actually archived, and if it is, retrieve
 * the S3 bucket name where the compressed dump is stored.  Next, retrieve
 * the dump from S3 and restore it. Finally, update the database to reflect
 * the fact that the report is no longer archived.
 * 
 * @param{number} id - key of report to be restored
 * @return{Promise} Promise resolved when specified report has been restored 
 */
export function restoreReport(id: number): Promise<{}> {
    return new Promise<string>((resolve, reject) => {
        let tmpFile: string;
        logger.info(() => ["Initiating restore of report %d", id]);
        // Get a temporary file to hold the s3 object
        generateTmpFile()
            // Retrieve the S3 location of the report
            .then(fn => {
                logger.debug(() => ["Temporary file for restore: %s", fn]);
                tmpFile = fn;
                return get_report_s3_location(db, id);
            })
            // Retrieve report's compressed dump from S3 and store it in the temp file
            .then((s3loc) => {
                logger.debug(() => ["S3 location of report %d: %s", id, s3loc]);
                let firstSlashPos = s3loc.indexOf('/');
                if (firstSlashPos <= 0 || firstSlashPos === s3loc.length - 1) {
                    let msg = `Unable to determine bucket and key from s3location: ${s3loc}`;
                    logger.warn(() => [msg]);
                    reject(msg);
                }
                return download(tmpFile, s3loc.substr(0, firstSlashPos), s3loc.substr(firstSlashPos + 1));
            })
            // Restore the compressed dump using pg_restore
            .then(() => {
                logger.debug(() => ["Download of dump object successful. Initiating restore"]);
                return restore(tmpFile);
            })
            // Remove the temporary file containing the compressed dump
            .then(() => {
                logger.debug(() => ["Restore successful. Removing temporary file"]);
                return removeFile(tmpFile);
            })
            // Reset the "archive_location" and "archive_timestamp" in the report table to null,
            // indicating that the report is present in the DB
            .then(() => {
                logger.debug(() => ["Temporary file removal successful. Resetting archive columns in DB"]);
                return db.none(reset_report_s3_location_sql, [null, null, "now()", id])
            })
            // Restore complete
            .then(() => {
                logger.debug(() => ["DB update successful. Restore of report %d complete", id]);
                resolve();
            })
            // Log the failure message and reject the restore promise
            .catch(err => {
                logger.warn(() => ["Error restoring report %d: %s", id, err]);
                reject(err)
            })
    })
}

/**
 * Return a Promise resolved when the specified report is archived to S3,
 * and the objects associated with the report (including dependent analyses
 * have been removed from the DB. First, check if the report to be
 * archived is referenced by any non-archived analyses.  If so, archive the
 * analyses, then proceed to archive the specified report.
 * 
 * @param{number} id - key of report to be archived
 * @return{Promise} Promise resolved when specified report has been archived 
 *                  to S3.
 */
export function archiveReport(id: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        let cleanCommands: string = "BEGIN;\n"
        let tmpFile: string;
        let s3Location: string;

        logger.info(() => ["Initiating archive of report: %d", id]);
        // Validate that the report is present in the DB
        db.one(validate_report_present_sql, id)
            .then(() => {
                logger.debug(() => ["Report presence validated. Finding dependent analyses"]);
                return getDependentAnalyses(db, id)
            })
            .catch((err) => {
                let errMsg = `Report ${id} either does not exist or is already archived. Error: ${err}`;
                logger.warn(() => [errMsg]);
                throw new AlreadyArchivedOrDoesNotExistError(errMsg);
            })
            .then((deps) => {
                logger.debug(() => ["Dependent analyses retrieved: %s", JSON.stringify(deps)]);
                return archiveAnalyses(deps);
            })
            .then(ps => {
                ps.forEach(cmds => {
                    cleanCommands += cmds;
                })
                logger.debug(() => ["Dependent analyses archived"]);
                return generateTmpFile();
            })
            .then(fn => {
                tmpFile = fn;
                logger.debug(() => ["Temporary file for dump: %s", fn]);
                return dumpReport(id, tmpFile);
            })
            .then(() => {
                logger.debug(() => ["Report dumped"]);
                return uploadReportDump(id, tmpFile);
            })
            .then(url => {
                s3Location = url;
                logger.debug(() => ["Report dump uploaded to: %s", url]);
                // Inspect the dump for the SQL statements needed to drop the
                // objects associated with the specified analysis
                return getCleanCommands(tmpFile)
            })
            .then(cmds => {
                // Save the DB clean SQL along with a statement that sets the
                // state of the analysis to "archived". Then remove the
                // temporary file.
                cleanCommands += cmds;
                cleanCommands += `update ${config.db_connection.schema}.report set archive_location='${s3Location}',restore_timestamp=null,archive_timestamp=now() where id=${id};\n`;
                cleanCommands += "COMMIT;";
                logger.debug(() => ["Commands to clean DB of report id %d: %s", id, cleanCommands]);
                return removeFile(tmpFile)
            })
            .then((r) => {
                logger.debug(() => ["Initiating removal of DB objects associated with report: %d", id]);
                return execDBCmds(cleanCommands);
            })
            .then((r) => {
                resolve(s3Location);
            })
            .catch(err => {
                logger.warn(() => ["Error attempting to archive report %d: %s", id, err]);
                reject(err);
            })
    })
}