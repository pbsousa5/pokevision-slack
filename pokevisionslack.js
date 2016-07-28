/**
 * @author  Xenonyx
 * @license MIT
 * @see     github.com/xenonyx/pokevision-slack
 */

(function () {

    /*----- Constants -----*/

    /**
     * Array containing the latitude-longitude coordinates of the scan location.
     *
     * For this to work, pokevision.com must be loaded with the coordinates in the URL, eg:
     *
     *     https://pokevision.com/#/@51.507384,-0.127678
     *
     * @const {!Array<string>}
     */
    var SCAN_LOCATION_ARRAY = window.location.hash.replace('#/@', '').split(',');

    /**
     * Latitude-longitude coordinates of the scan location.
     *
     * @const {!Object}
     */
    var SCAN_LOCATION = {
        LAT:  Number(SCAN_LOCATION_ARRAY[0]),
        LONG: Number(SCAN_LOCATION_ARRAY[1])
    };

    /**
     * No notifications will be sent for Pokemon which are further than this distance from the scan location.
     *
     * @const {number} - Metres
     */
    var MAX_DISTANCE = 1000;

    /**
     * No notifications will be sent for these Pokemon.
     *
     * @const {!Array<string>}
     */
    var IGNORED_POKEMON = [
        'Caterpie',
        'Drowzee',
        'Pidgey',
        'Rattata',
        'Spearow',
        'Weedle',
        'Zubat'
    ];

    /**
     * Time interval at which to periodically call main().
     *
     * @const {number} - Seconds
     */
    var INTERVAL_MAIN = 30;

    /**
     * Time interval at which to periodically click PokeVision's
     * "Click To Find Pokemon Near Marker" button.
     *
     * This cannot be lower than 30 seconds, and should really be quite a bit higher
     * (eg: 2 minutes), since we want to minimise the load on PokeVision's API.
     *
     * @const {number} - Seconds
     */
    var INTERVAL_POKEVISION_BUTTON = 120;

    /**
     * If the number of consecutive API errors reaches this threshold,
     * then an "API down" notification will be sent.
     *
     * @const {number}
     */
    var API_DOWN_THRESHOLD = 50;

    /**
     * Regular expression for validating Slack webhook URLs.
     *
     * @const {!Regex}
     * @see   api.slack.com/incoming-webhooks
     */
    var SLACK_WEBHOOK_URL_REGEX = /^https:\/\/hooks.slack.com\/services\/[0-9A-Z]+\/[0-9A-Z]+\/[0-9A-Za-z]+$/;

    /**
     * localStorage key for storing the Slack webhook URL.
     *
     * @const {string}
     * @see   developer.mozilla.org/en-US/docs/Web/API/Window/localStorage
     */
    var SLACK_WEBHOOK_URL_LOCALSTORAGE_KEY = 'slack_webhook_url';


    /*----- Variables -----*/

    /**
     * Fingerprints of unique Pokemon occurrences which have already been seen.
     * This is used to ensure that only one notification is sent for each unique Pokemon occurrence.
     *
     * @type {!Array<string>}
     */
    var seenPokemonFingerprints = [];

    /**
     * Is this the first time that main() has been called?
     *
     * @type {boolean}
     */
    var isFirstRun = true;

    /**
     * Variable which counts the number of consecutive API errors.
     *
     * @type {number}
     */
    var apiErrorCounter = 0;

    /**
     * Webhook URL for Slack notifications.
     *
     * @type {string}
     * @see  api.slack.com/incoming-webhooks
     */
    var slackWebhookUrl = '';


    /*----- Classes -----*/

    /**
     * Class representing a single Pokemon.
     *
     * @param {!Object} rawPokemon - From PokeVision
     * @constructor
     */
    function Pokemon(rawPokemon) {

        // rawPokemon has this structure:
        //     data:            "[]"
        //     expiration_time: 1469651613
        //     id:              218546896
        //     is_alive:        true
        //     latitude:        51.506187611511
        //     longitude:       -0.13159736525735
        //     pokemonId:       96
        //     uid:             "487604d1ab5:19"

        this.rawData  = $.extend({}, rawPokemon);  // Clone
        this.name     = App.home.pokedex[rawPokemon.pokemonId];
        this.distance = this.calculateDistance();

        // The fingerprint is used to uniquely identify a Pokemon occurrence.
        // (rawPokemon does contain an "id" property, but this doesn't seem to be unique: there can
        // be multiple identical Pokemon at an identical location, with different "id" values.)
        this.fingerprint = [
            this.name,
            rawPokemon.latitude,
            rawPokemon.longitude
        ].join(',');

    }

    /**
     * Pokemon: Calculate the distance from the scan location.
     *
     * @return {number} - Metres
     * @see    stackoverflow.com/a/27943
     */
    Pokemon.prototype.calculateDistance = function () {

        var lat1 = this.rawData.latitude;
        var lon1 = this.rawData.longitude;
        var lat2 = SCAN_LOCATION.LAT;
        var lon2 = SCAN_LOCATION.LONG;

        var R    = 6371;  // Radius of the Earth in km
        var dLat = deg2rad(lat2 - lat1);
        var dLon = deg2rad(lon2 - lon1);

        var a = Math.sin(dLat / 2)      * Math.sin(dLat / 2) +
                Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
                Math.sin(dLon / 2)      * Math.sin(dLon / 2);

        var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        var d = R * c;  // Distance in km

        return Math.round(d * 1000);  // Distance in metres

    };

    /**
     * Pokemon: Format and return the expiration time.
     *
     * @return {string}
     */
    Pokemon.prototype.formatExpirationTime = function () {

        var expirationUnix = this.rawData.expiration_time;

        var seconds = Math.floor(expirationUnix - (Date.now() / 1000));
        var minutes = Math.floor(seconds / 60);

        seconds -= (minutes * 60);

        return '' + minutes + ':' + (seconds < 10 ? '0' : '') + seconds;

    };

    /**
     * Pokemon: Format and return the notification message.
     *
     * @return {string}
     */
    Pokemon.prototype.formatNotificationMessage = function () {

        var url = 'https://pokevision.com/#/@' + this.rawData.latitude + ',' + this.rawData.longitude;

        var items = [
            formatCurrentTime(),
            '*<' + url + '|' + this.name + '>*',
            this.distance + 'm away',
            this.formatExpirationTime() + ' left'
        ];

        return items.join('  —  ');

    };


    /*----- Functions -----*/

    /**
     * Is the specified value a string?
     *
     * @param  {*} value
     * @return {boolean}
     */
    function isString(value) {

        return (typeof value === 'string');

    }

    /**
     * Convert an angle from degrees to radians.
     *
     * @param  {number} deg
     * @return {number}
     */
    function deg2rad(deg) {

        return deg * (Math.PI / 180);

    }

    /**
     * Format the current time.
     *
     * @return {string}
     * @see    developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/toLocaleTimeString#Using_locales
     */
    function formatCurrentTime() {

        var d    = new Date();
        var time = d.toLocaleTimeString('en-US');  // US English uses 12-hour time with AM/PM: "12:30:00 PM"

        return time.toLowerCase().replace(' ', '');  // "12:30:00pm"

    }

    /**
     * Log the specified message to the console, prefixed with the current time.
     *
     * @param {*}       message
     * @param {string=} logMethod - One of: "error", "group", "groupCollapsed", "info", "log", "warn"
     * @see   developer.mozilla.org/en-US/docs/Web/API/Console
     */
    function logWithTime(message, logMethod) {

        if (!isString(logMethod)) {
            logMethod = 'log';
        }

        console[logMethod]('[' + formatCurrentTime() + '] ' + message);

    }

    /**
     * Is the specified Slack webhook URL valid?
     *
     * @param  {*} url
     * @return {boolean}
     */
    function isSlackWebhookUrlValid(url) {

        if (!isString(url)) {
            return false;
        }

        return (url.search(SLACK_WEBHOOK_URL_REGEX) !== -1);

    }

    /**
     * Obtain the Slack webhook URL, either from localStorage, or by prompting the user.
     *
     * @return {string}
     * @throws {Error} if no valid URL could be obtained
     */
    function obtainSlackWebhookUrl() {

        var url = '';

        try {
            url = window.localStorage.getItem(SLACK_WEBHOOK_URL_LOCALSTORAGE_KEY);
            if (isSlackWebhookUrlValid(url)) {
                window.alert('Your stored Slack webhook URL will be used:\n' + url);
            } else {
                url = window.prompt(
                    'Please enter your Slack webhook URL.\nThe URL will be stored in localStorage for future use.'
                );
                if (isSlackWebhookUrlValid(url)) {
                    window.localStorage.setItem(SLACK_WEBHOOK_URL_LOCALSTORAGE_KEY, url);
                }
            }
        } catch (e) {
            url = window.prompt(
                'Please enter your Slack webhook URL.\nNote: localStorage is ' +
                'not available, so the URL cannot be stored for future use.'
            );
        }

        if (!isSlackWebhookUrlValid(url)) {
            window.alert('Slack webhook URL is invalid or missing.\nTerminating the script.');
            throw new Error('Slack webhook URL is invalid or missing');
        }

        return url;

    }

    /**
     * Send a Slack notification with the specified message.
     *
     * @param {string} message
     * @see   api.slack.com/incoming-webhooks
     */
    function sendSlackNotification(message) {

        var jsonPayload = JSON.stringify({
            text: message
        });

        if (isSlackWebhookUrlValid(slackWebhookUrl)) {
            $.post(slackWebhookUrl, jsonPayload);
        } else {
            console.error(
                'Cannot send Slack notification: invalid or missing Slack webhook URL: ' + slackWebhookUrl
            );
        }

    }

    /**
     * The main function.
     */
    function main() {

        console.log(formatCurrentTime() + ' main()');

        var nearbyPokemon = [];

        App.home.pokemon.forEach(function (rawPokemon) {

            var pokemon = new Pokemon(rawPokemon);

            if (IGNORED_POKEMON.indexOf(pokemon.name) !== -1) {
                console.log('Skipping (ignored) - ' + pokemon.fingerprint);
                return;
            }

            if (pokemon.distance > MAX_DISTANCE) {
                console.log('Skipping (distance) - ' + pokemon.fingerprint + ' - ' + pokemon.distance + 'm');
                return;
            }

            if (seenPokemonFingerprints.indexOf(pokemon.fingerprint) !== -1) {
                console.log('Skipping (already seen) - ' + pokemon.fingerprint);
                return;
            }

            nearbyPokemon.push(pokemon);

            seenPokemonFingerprints.push(pokemon.fingerprint);

            console.log(pokemon);

        });

        nearbyPokemon.sort(function (a, b) {
            return (a.distance - b.distance);
        });

        if (nearbyPokemon.length > 0 && !isFirstRun) {

            var messageLines = nearbyPokemon.map(function (pokemon) {
                return pokemon.formatNotificationMessage();
            });

            var message = messageLines.join('\n');

            console.log(message);

            sendSlackNotification(message);

        }

        isFirstRun = false;

    }


    /*----- API down detection -----*/

    // PokeVision uses its App.request() function for all GET Ajax requests to the API.
    // By injecting a man-in-the-middle function here, we can inspect the API's responses,
    // and send a Slack notification if the API is down.

    var AppRequestOriginal = App.request;

    App.request = function (url, successCallback, errorCallback) {

        console.log('App.request(' + url + ')');

        var newSuccessCallback = function (successData) {

            successCallback(successData);

            // We're only interested in responses from /map/data
            if (url.indexOf('map/data') === -1) {
                return;
            }

            // If the jobStatus property is set, it will have a value of "in_progress", "failure" or "unknown",
            // and indicates that the list of nearby Pokemon isn't currently available.
            if (successData.jobStatus) {

                apiErrorCounter++;

                console.log('apiErrorCounter = ' + apiErrorCounter);

                if (apiErrorCounter === API_DOWN_THRESHOLD) {
                    console.log('PokeVision is down');
                    sendSlackNotification(
                        "PokeVision is down :crying_cat_face: Check https://twitter.com/pokevisiongo"
                    );
                }

            } else {

                if (apiErrorCounter >= API_DOWN_THRESHOLD) {
                    console.log('PokeVision is up');
                    sendSlackNotification("PokeVision is back up. Go catch 'em all! :smiley_cat:");
                }

                apiErrorCounter = 0;

            }

        };

        AppRequestOriginal(url, newSuccessCallback, errorCallback);

    };


    /*----- Main -----*/

    slackWebhookUrl = obtainSlackWebhookUrl();

    main();

    setInterval(
        function () {
            main();
        },
        INTERVAL_MAIN * 1000
    );

    setInterval(
        function () {
            console.log(formatCurrentTime() + ' Clicking home-map-scan');
            $('.home-map-scan').trigger('click');
        },
        INTERVAL_POKEVISION_BUTTON * 1000
    );

})();
