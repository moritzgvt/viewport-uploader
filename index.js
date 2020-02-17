"use strict";

// ----------------- Dependencies ----------------- //

const path = require('path');
const os = require('os');
const through = require("through2");
const fs = require('fs');
const slash = require("slash"); // ToDo: Can't use path.join() for URLs since on windows / would be \\

const { loadConfig } = require('./lib/files.js');
const { fetchTheme, existsTheme, createTheme, resetTheme, uploadTheme } = require('./lib/network.js');
const { regexVal } = require('./lib/validate.js');
const { showError, showLog } = require('./lib/chalk.js');

// ----------------- Configuration ----------------- //

const vpconfigName = ".vpconfig.json";
const vpconfigPath = path.join(os.homedir(), vpconfigName); // absolute path

// ToDo: put in proper restrictions from Scroll Viewport
// Note: If you change something here change it in viewport-tools as well!
const envTemplate = {
    'envName': /.*/i,
    'confluenceBaseUrl': /^(https?):\/\/[^\s$.?#].[^\s]*[^/]$/i,
    'username': /.*/i,
    'password': /.*/i,
    'scope': /.*/i,
    'targetPath': /^(\.\/|\/)(\w+\/)*$/i,
    'sourcePath': /^(\.\/|\/)(\w+\/)*$/i
};

const RESTURL_BASE = `/rest/scroll-viewport/1.0`;
const getRestUrlForThemeObject = (baseUrl, themeName, scope) => baseUrl + `/theme?name=${themeName}&scope=${scope}`;
const getRestUrlForThemeCreation = (baseUrl) => baseUrl + `/theme`;
const getRestUrlForThemeResources = (baseUrl, themeId) => baseUrl + `/theme/${themeId}/resource`;

// ----------------- Class ----------------- //

class ViewportTheme {

    constructor(themeName, envName) {
        // themeId doesn't need to be provided, can use themeName instead

        // validate themeName or themeId
        if (!themeName || !envName) {
            showError(`Can't initialize ViewportTheme instance since themeName or envName are missing. Please provide both.`)
        }

        // load target environment from config file
        const targetEnv = loadConfig(
            { 'envName': envName, 'vpconfigName': vpconfigName, 'vpconfigPath': vpconfigPath, 'envTemplate': envTemplate });

        // validate target environment, if targetEnv passes check contains exactly the properties of envTemplate
        if (!regexVal(envTemplate, targetEnv)) {
            showError(
                `The target environment '${envName}' in ~/${vpconfigName} contains invalid properties. Please use 'viewport config\' to configure target environments.`);
        }

        // copy properties of targetEnv into 'this'
        this.themeName = themeName;
        const envTemplateKeys = Object.keys(envTemplate);
        envTemplateKeys.forEach(item => {
            this[item] = targetEnv[item]
        });

        showLog(`The target environment '${envName}' will be used for the theme '${themeName}'.`);
    }

    // use getters for properties that depend on others to keep it dynamic
    get autorisation() {
        return 'Basic ' + Buffer.from(this.username + ':' + this.password).toString('base64');
    }

    get restUrlBase() {
        return this.confluenceBaseUrl + RESTURL_BASE;
    }

    get restUrlForThemeObject() {
        return getRestUrlForThemeObject(this.restUrlBase, this.themeName, this.scope);
    }

    get restUrlForThemeCreation() {
        return getRestUrlForThemeCreation(this.restUrlBase);
    }

    // call only in methods after create(), i.e. update() and reset()
    get restUrlForThemeResources() {
        if (!this.themeId) {
            showError(
                `Can't build REST URL for theme resources because themeId isn't initialised yet. Please create the theme first.`)
        }
        return getRestUrlForThemeResources(this.restUrlBase, this.themeId);
    }

    // private property to store if theme exists in Scroll Viewport
    #doesThemeExist;

    // checks if a theme exists in Scroll Viewport
    // ToDo: If possible in ESNext, make private method, or even better a getter method that closes over internal doesThemeExist variable
    // so not even Class has access to it
    async exists() {
        showLog(`Checking if theme \'${this.themeName}\' exists in Scroll Viewport...`);

        // on first run set if theme exists or not
        if (this.#doesThemeExist === undefined) {
            this.#doesThemeExist = await existsTheme.apply(this);
        }

        showLog(`The theme \'${this.themeName}\' does ${this.#doesThemeExist ? 'exist' : 'not exist'} in Scroll Viewport.`);
        return this.#doesThemeExist;
    };

    // creates theme in Scroll Viewport
    async create() {
        showLog(`Creating theme '${this.themeName}' in Scroll Viewport...`);

        if (await this.exists()) {
            showLog(`Will not create theme \'${this.themeName}\' since it already exists.`);
            // don't throw otherwise other methods are unusable since themeId is not set yet
            // showError(`Can not create theme \'${this.themeName}\' since it already exists.`)
        } else {
            await createTheme.apply(this);
            showLog(`The theme '${this.themeName}' has been successfully created.`);
        }

        // set themeId such that upload() and reset() can use it
        const theme = await fetchTheme.apply(this);
        this.themeId = theme.id;
    }

    // removes all resources from theme in Scroll Viewport
    async reset() {
        showLog(`Resetting theme '${this.themeName}' in Scroll Viewport...`);

        if (!await this.exists()) {
            showError(
                `Can't reset resources since theme \'${this.themeName}\' doesn't exist yet in Scroll Viewport. Please create it first.`)
        }

        await resetTheme.apply(this);

        showLog(`The theme '${this.themeName}' has been successfully reset.`);
    }

    // overwrites existing resources in theme with new ones in Scroll Viewport
    // returns a stream so other gulp plugins can be piped on to it
    async upload() {
        showLog(`Uploading resources to theme '${this.themeName}' in Scroll Viewport...`);

        if (!await this.exists()) {
            showError(
                `Can't update resources since theme \'${this.themeName}\' doesn't exist yet in Scroll Viewport. Please create it first.`)
        }


        // ToDo: finish, just copied from indexOrig.js, not ready yet
        return through.obj((file, enc, callback) => {
            // ToDo: figure out if really can handle file.isStream() and file.isBuffer()
            // this.emit('error', new PluginError(PLUGIN_NAME, 'Streams not supported!'));
            // this.emit('error', new PluginError(PLUGIN_NAME, 'Buffers not supported!'));
            if (file.isNull()) {
                return callback(null, file);
            }

                //   this can be extended with following options
                //             {
                //                 sourceBase: 'build/css/main.css',
                //                 targetPath: 'css/main.css'
                //             }

                // ToDo: fix what it does
                const sourceBase = slash(path.relative(this.sourceBase, file.history[0]));
                const relativeSourceFilePath = slash(path.relative(process.cwd(), file.history[0]));
                const sourceBasedFilePath = slash(path.relative(this.sourceBase, relativeSourceFilePath));
                const targetPathFilePath = slash(path.relative(this.targetPath, sourceBasedFilePath));
                const targetPathStart = slash(path.relative(process.cwd(), this.targetPath));

                const targetPath = this.targetPath.match(/\.\w+?$/) ? targetPathStart : targetPathFilePath;
                const sourceBasePath = this.sourceBase.match(/\.\w+?$/) ? this.sourceBase : relativeSourceFilePath;

                filesToUpload.push(
                    {
                        path: targetPath,
                        file: fs.createReadStream(sourceBasePath)
                    }
                );

            callback(null, file);

        }, (cb) => {

            const uploadedFiles = await uploadTheme.apply(this, filesToUpload);

            showLog(`${uploadedFiles.length} resources for the theme '${this.themeName}' have been successfully uploaded.`);
        });
    }
}

exports.ViewportTheme = ViewportTheme;