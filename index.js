var events = require('events'),
    semver = require('semver'),
    request = require('request'),
    _ = require('lodash'),
    Q = require('q');

module.exports = function(widgets, templates, styles, auth) {

    templates.push('./templates');
    styles.addWidgetStylesheet('server-versions', './styles/server-versions.scss');

    widgets.register('server-versions', function(config) {

        var emitter = new events.EventEmitter(),
            jira;

        jira = createRequest({
            auth: auth.get(config.auth),
            baseUrl: config.host + '/rest/api/2/',
            timeout: config.timeout || 15000,
            headers: {
                accept: "application/json"
            }
        });


        function go() {
            loadJiraProjectVersions(jira, config.projects)
                .then(loadServerVersions)
                .then(compareVersions)
                .then(function(projects) {
                    emitter.emit('data', {headline: config.headline || 'Server Versions', projects: projects});
                    setTimeout(go, config.interval || 60000);
                })
                .catch(function(error) {
                    emitter.emit('error', error);
                    setTimeout(go, 50000);
                })
        }

        process.nextTick(go);

        return emitter;
    });

}
module.exports.$inject = ['widgetFactory', 'templateManager', 'stylesManager', 'authManager'];

/**
 * Creates a request instance with given default options. Returns promise which resolves into
 * a json parsed object.
 *
 * @param {object} options
 * @returns {Q.Promise}
 */
function createRequest(options) {

    var bamboo = request.defaults(options);

    return function(resource) {
        var deferred = Q.defer();

        bamboo.get(resource, function(error, response, body) {

            if (error) {
                return deferred.reject(error);
            }

            if (response.statusCode !== 200) {
                try {
                    var message = JSON.parse(body).message
                } catch (e) {}
                return deferred.reject(message || response.statusMessage);
            }

            deferred.resolve(JSON.parse(body));
        });

        return deferred.promise;
    }
}

/**
 * Loads highest version number from jira for each project.
 *
 * @param {request.Request} jira
 * @param {object} projects
 * @returns {object}
 */
function loadJiraProjectVersions (jira, projects) {
    var projects = _.cloneDeep(projects);
    return Q.all(projects.map(function(project) {
        return jira("project/" + project.project + "/versions").then(function(data) {
            project.version = _.reduce(data, function(memo, version) {
                if(semver.valid(version.name)) {
                    if (version.released && (!memo || semver.gt(version.name, memo))) {
                        return semver.parse(version.name);
                    } else {
                        return memo;
                    }
                }
            }, null);

            return project;
        });
    }));
}

function loadServerVersions (projects) {
    return Q.all(projects.map(function(project) {
        return Q.all(project.servers.map(function(server) {
            var deferred = Q.defer();
            request(server.url, function(error, response, body) {
                server.current = semver.parse(body.trim("\n"));
                deferred.resolve();
            });
            return deferred.promise;
        }))
    }))
    .then(function() {
        return projects;
    });
}

function compareVersions(projects) {

    projects.forEach(function (project) {
        var projectVer = project.version;

        project.servers.forEach(function(server) {
            var serverVer = server.current;

            server.newer = false;
            server.needsMajorUpdate = false;
            server.needsMinorUpdate = false;
            server.needsPatchUpdate = false;
            server.versionDiff = 0;
            server.current = serverVer ? serverVer.format() : null;

            if (serverVer && projectVer) {
                if (serverVer.compare(projectVer) > 0) {
                    server.newer = true;
                } else if (serverVer.major < projectVer.major) {
                    server.needsMajorUpdate = true;
                    server.versionDiff = projectVer.major - serverVer.major
                } else if (serverVer.minor < projectVer.minor) {
                    server.needsMinorUpdate = true;
                    server.versionDiff = projectVer.minor - serverVer.minor
                } else if (serverVer.patch < projectVer.patch) {
                    server.needsPatchUpdate = true;
                    server.versionDiff = projectVer.patch - serverVer.patch
                }
            }

        });
    });

    return projects;
}
