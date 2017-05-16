global.sails = {
    "config": {
        "archiveRestoreConfig": {
            "s3_bucket": "tomtomapac.com.trafficstats",
            "pg_prefix": "/usr/local/bin",
            "logger": {
                "directory": "logs",
                "filename": "trafficstats",
                "level": "debug"
            },
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
    }
}

const rewire = require("rewire");
const assert = require('assert');
const fs = require("fs")
const ts = rewire('../dist/ts-archive-restore');

describe('trafficstats-archive-restore', function () {

    describe('#execDBCmds()', function () {
        it('should execute a simple select', done => {
            ts.__get__('execDBCmds')("select 1 from report").then(() => console.log("success")).catch(err => assert.fail(err));
            done();
        });
    });

    describe('logger', function () {
        let logger = ts.__get__("logger");
        it('should log a verbose message', done => {
            logger.verbose(() => ["verbose"])
            done();
        });
        it('should log a info message', done => {
            logger.info(() => ["info"])
            done();
        });
        it('should log a warn message', done => {
            logger.warn(() => ["warn"])
            done();
        });
        it('should log a error message', done => {
            logger.error(() => ["error"])
            done();
        });
    });

    describe('generate temp file', function () {
        let generateTmpFile = ts.__get__("generateTmpFile");
        let tmpFile;
        it('should generate a valid temporary file path', done => {
            generateTmpFile().then(fn => {
                tmpFile = fn;
                fs.writeFileSync(fn, "This is a test", "utf8");
                let = data = fs.readFileSync(fn, 'utf8')
                fs.unlinkSync(fn);
                assert.equal(data, "This is a test");
                done();
            })
        })
    });

    describe('object archive/restore', function () {
        /**
         * Analysis 4 depends on reports 74 and 75.  This test
         * first archives report 74.  Because archive 4 will
         * be unusable without both needed reports present, analysis
         * 4 will be implicitly archived as part of report 74's archival.
         * Next, report 75 is archived.  No other archival is necessary,
         * because we'll notive that analysis 4 is already archived. Finally,
         * we restore analysis 4.  We notice that it depends on reports 74 and 75,
         * both of which are now archived, so they will be implicitly restored.
         * Finally, analysis 4 is restored, and the DB will be as we found it. This
         * test also tests the restoreReport(n) function.
         */
        let archiveReport = ts.__get__("archiveReport");
        let restoreReport = ts.__get__("restoreReport");
        let restoreAnalysis = ts.__get__("restoreAnalysis");
        it('should archive report 74', done => {
            archiveReport(74).then(() => {
                done();
            })
                .catch(err => { throw (err) });
        }).timeout(0)
        it('should archive report 75', done => {
            archiveReport(75).then(() => {
                done();
            })
                .catch(err => { throw (err) });
        }).timeout(0)
        it('should restore analysis 4 after implicitly restoring reports 74 and 75', done => {
            restoreAnalysis(4).then(() => {
                done();
            })
                .catch(err => { throw (err) });
        }).timeout(0)
    })
})