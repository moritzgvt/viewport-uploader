"use strict";

// ----------------- Dependencies ----------------- //

const path = require('path');
const os = require('os');
const PluginError = require('plugin-error');

const { loadConfig, loadConfigSync, createFormData, resolveGlob } = require('./lib/files.js');
const { fetchTheme, existsTheme, createTheme, resetTheme, uploadTheme } = require('./lib/network.js');
const { regexVal } = require('./lib/validate.js');
const { showLog } = require('./lib/console.js');

// ----------------- Configuration ----------------- //

const PLUGIN_NAME = 'gulp-viewport';

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
};

const uplTemplate = {
    'targetPath': /^(\w+\/)*$/i,
    'sourcePath': /^(\w+\/)*$/i,
    'globString': /.*/i,
};

const RESTURL_BASE = `/rest/scroll-viewport/1.0`;
const getRestUrlForThemeObject = (baseUrl, themeName, scope) => baseUrl + `/theme?name=${themeName}&scope=${scope}`;
const getRestUrlForThemeCreation = (baseUrl) => baseUrl + `/theme`;
const getRestUrlForThemeResources = (baseUrl, themeId) => baseUrl + `/theme/${themeId}/resource`;

// ----------------- Class ----------------- //

class ViewportTheme {

    // private property to store if theme exists in Scroll Viewport
    #doesThemeExist;

    // ------------ Constructor ------------ //

    constructor(themeName, envName) {
        showLog(`The target environment '${envName}' will be used for the theme '${themeName}'.`);

        // validate themeName or themeId
        if (!themeName || !envName) {
            throw new PluginError(PLUGIN_NAME, `Can't initialize ViewportTheme instance since themeName or envName are missing. Please provide both.`)
        }

        // ToDo: with ESNext make async constructor
        // load target environment from config file
        const targetEnv = loadConfigSync(envName, vpconfigName, vpconfigPath, envTemplate);

        // validate target environment, if targetEnv passes check contains exactly the properties of envTemplate
        if (!regexVal(envTemplate, targetEnv)) {
            throw new PluginError(PLUGIN_NAME,
                `The target environment '${envName}' in ~/${vpconfigName} contains invalid properties. Please use 'viewport config\' to configure target environments.`);
        }

        // copy properties of targetEnv into 'this'
        this.themeName = themeName;

        const envTemplateKeys = Object.keys(envTemplate);
        envTemplateKeys.forEach(item => {
            this[item] = targetEnv[item]
        });

        // Note: set later in create() because JS doesn't support async functions inside constructor (yet)
        this.themeId = undefined;
        this.#doesThemeExist = undefined;
    }

    // ------------ Getters ------------ //

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

    // call only after create() because it depends on themeId which is computed in create(), i.e. in update() and reset()
    get restUrlForThemeResources() {
        if (!this.themeId) {
            throw new PluginError(PLUGIN_NAME,
                `Can't build REST URL for theme resources because themeId isn't initialised yet. Please create the theme first.`)
        }
        return getRestUrlForThemeResources(this.restUrlBase, this.themeId);
    }

    // ------------ Methods on prototype chain ------------ //

    // ToDo: If possible in ESNext, make private method, or even better a async getter method that closes over doesThemeExist variable so not even class has access to it
    // checks if a theme exists in Scroll Viewport
    async exists() {

        // on first run set if theme exists or not
        if (this.#doesThemeExist === undefined) {
            showLog(`Checking if theme \'${this.themeName}\' exists in Scroll Viewport...`);
            this.#doesThemeExist = await existsTheme.apply(this);
        }

        showLog(`The theme \'${this.themeName}\' does ${this.#doesThemeExist ? 'exist' : 'not exist'} in Scroll Viewport.`);
        return this.#doesThemeExist;
    };

    // creates theme in Scroll Viewport
    async create() {

        if (await this.exists()) {
            showLog(`Won't create theme \'${this.themeName}\' since it already exists.`);
            // don't throw otherwise other methods are unusable since themeId is not set yet
            // throw new PluginError(PLUGIN_NAME, `Can not create theme \'${this.themeName}\' since it already exists.`)
        } else {
            showLog(`Creating theme '${this.themeName}' in Scroll Viewport...`);
            await createTheme.apply(this);
            showLog(`The theme '${this.themeName}' has been successfully created.`);
        }

        // set themeId such that upload() and reset() can use it
        const theme = await fetchTheme.apply(this);
        this.themeId = theme.id;
    }

    // removes all resources from theme in Scroll Viewport
    async reset() {

        // obligatory existence check
        if (!await this.exists()) {
            throw new PluginError(PLUGIN_NAME,
                `Can't reset resources since theme \'${this.themeName}\' doesn't exist yet in Scroll Viewport. Please create it first.`)
        }

        showLog(`Resetting theme '${this.themeName}' in Scroll Viewport...`);

        await resetTheme.apply(this);

        showLog(`The theme '${this.themeName}' has been successfully reset.`);
    }

    // overwrites existing resources in theme with new ones in Scroll Viewport
    async upload(args) {

        // obligatory existence check
        if (!await this.exists()) {
            throw new PluginError(PLUGIN_NAME,
                `Can't update resources since theme \'${this.themeName}\' doesn't exist yet in Scroll Viewport. Please create it first.`)
        }

        // validate arguments, if args passes check contains exactly the properties of uplTemplate
        if (!regexVal(uplTemplate, args)) {
            throw new PluginError(PLUGIN_NAME,
                `The arguments passed are invalid. Please provide an object of the form \'{ ${Object.keys(uplTemplate).join(", ")} }\'.`);
        }

        // compute paths
        const {targetPath, sourcePath, globString} = args;

        let sourcePaths = await resolveGlob(globString);

        if (!sourcePaths.length) {
            showLog(`Won't upload since no files matching the glob pattern \'${globString}\' were found.`);
            return; // break out of function, async func returns a resolved promise with value undefined, same as if it finished until end
        }

        const targetPaths = sourcePaths.map(item => path.join(targetPath, path.relative(sourcePath, item)));

        // log paths
        showLog(`Uploading ${sourcePaths.length} resources to theme '${this.themeName}' in Scroll Viewport...`);
        sourcePaths.forEach((_, i) => {console.log(sourcePaths[i] + " => " + targetPaths[i])});

        // create form data and upload
        const formData = await createFormData(sourcePaths, targetPaths);
        const uploadedFilePaths = await uploadTheme.call(this, formData);

        // log success
        showLog(`${uploadedFilePaths.length} resources for the theme '${this.themeName}' have been successfully uploaded.`);
        uploadedFilePaths.forEach(item => {console.log(item)});
    }
}

exports.ViewportTheme = ViewportTheme;