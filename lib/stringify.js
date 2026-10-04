'use strict';

var getSideChannel = require('side-channel');
var utils = require('./utils');
var formats = require('./formats');
var has = Object.prototype.hasOwnProperty;

var arrayPrefixGenerators = {
    brackets: function brackets(prefix) {
        return prefix + '[]';
    },
    comma: 'comma',
    indices: function indices(prefix, key) {
        return prefix + '[' + key + ']';
    },
    repeat: function repeat(prefix) {
        return prefix;
    }
};

var isArray = Array.isArray;
var push = Array.prototype.push;
var pushToArray = function (arr, valueOrArray) {
    push.apply(arr, isArray(valueOrArray) ? valueOrArray : [valueOrArray]);
};

var toISO = Date.prototype.toISOString;

// RFC 3986 reserved characters (gen-delims and sub-delims), with `#` (a
// gen-delims that terminates the query component) and `[`/`]` (reserved for
// IP literals and not permitted in a query) omitted.
var allowReservedReplacements = {
    '%2A': '*',
    '%2B': '+',
    '%2C': ',',
    '%2F': '/',
    '%3A': ':',
    '%3B': ';',
    '%3D': '=',
    '%3F': '?',
    '%21': '!',
    '%24': '$',
    '%26': '&',
    '%27': "'",
    '%28': '(',
    '%29': ')',
    '%40': '@'
};

var allowReservedTokens = Object.keys(allowReservedReplacements);
var allowReservedTokenRegex = new RegExp(allowReservedTokens.join('|'), 'g');
var allowReservedChars = allowReservedTokens.map(function (token) {
    return allowReservedReplacements[token];
});

// These can never be emitted verbatim:
// - `&` and `#` truncate or alter the query when it is appended to a URL
// - `+` is decoded to a space by qs.parse, so it cannot round trip
// - `#` additionally starts the URL fragment
var alwaysEncodedReserved = [
    '&',
    '+',
    '#'
];

var isReservedMatch = function isReservedMatch(delimiter, reservedChar) {
    if (utils.isRegExp(delimiter)) {
        var pattern = delimiter;
        pattern.lastIndex = 0;
        var matched = pattern.test(reservedChar);
        pattern.lastIndex = 0;
        return matched;
    }
    return String(delimiter).indexOf(reservedChar) !== -1;
};

// Builds the encoder used when `allowReserved` is enabled and no custom
// encoder was provided. It encodes exactly like the default encoder and then
// leaves RFC 3986 reserved characters verbatim in *values*, except for the
// ones that would break splitting, key/value separation, or round tripping
// through qs.parse with the corresponding options.
var makeReservedEncoder = function makeReservedEncoder(delimiter, commaIsSeparator) {
    var forbiddenReserved = alwaysEncodedReserved.slice();

    for (var i = 0; i < allowReservedChars.length; ++i) {
        var charToCheck = allowReservedChars[i];
        if (forbiddenReserved.indexOf(charToCheck) === -1 && isReservedMatch(delimiter, charToCheck)) {
            forbiddenReserved.push(charToCheck);
        }
    }

    // qs.parse splits comma-joined values only with `comma: true`, which
    // corresponds to `arrayFormat: 'comma'`; see lib/parse.js.
    if (commaIsSeparator && forbiddenReserved.indexOf(',') === -1) {
        forbiddenReserved.push(',');
    }

    var forbiddenTokens = forbiddenReserved.map(function (reservedChar) {
        return '%' + reservedChar.charCodeAt(0).toString(16).toUpperCase();
    });

    return function allowReservedEncoder(str, defaultEncoder, charset, kind) {
        // The `arrayFormat: 'comma'` pre-join map calls the encoder with one
        // argument (see utils.maybeMap); those values are subsequently joined
        // on raw commas, so commas must remain encoded in them.
        var commaForbidden = arguments.length === 1;

        var encoded = utils.encode(str, defaultEncoder, charset, kind);

        // only values may keep reserved characters; keys are unchanged
        if (kind !== 'value' && !commaForbidden) {
            return encoded;
        }

        // The iso-8859-1 encoder uses `escape`, which leaves `+` verbatim, but
        // qs.parse always decodes `+` as a space; encode it so it round trips.
        if (charset === 'iso-8859-1') {
            encoded = encoded.replace(/\+/g, '%2B');
        }

        // The parser locates key/value boundaries via the first `]=` (bracket
        // keys split on `]=`, plain keys on `=`); a `]=` inside the value is
        // therefore mistaken for the boundary. `]` itself is always encoded,
        // so when both appear in an encoded value, `=` must stay encoded too.
        var keepEqualsEncoded = encoded.indexOf('%5D%3D') !== -1;

        return encoded.replace(allowReservedTokenRegex, function (token) {
            if (
                (keepEqualsEncoded && token === '%3D')
                || forbiddenTokens.indexOf(token) !== -1
            ) {
                return token;
            }
            return allowReservedReplacements[token];
        });
    };
};

var defaultFormat = formats['default'];
var defaults = {
    addQueryPrefix: false,
    allowDots: false,
    allowEmptyArrays: false,
    allowReserved: false,
    arrayFormat: 'indices',
    charset: 'utf-8',
    charsetSentinel: false,
    commaRoundTrip: false,
    delimiter: '&',
    encode: true,
    encodeDotInKeys: false,
    encoder: utils.encode,
    encodeValuesOnly: false,
    filter: void undefined,
    format: defaultFormat,
    formatter: formats.formatters[defaultFormat],
    // deprecated
    indices: false,
    serializeDate: function serializeDate(date) {
        return toISO.call(date);
    },
    skipNulls: false,
    strictNullHandling: false
};

var isNonNullishPrimitive = function isNonNullishPrimitive(v) {
    return typeof v === 'string'
        || typeof v === 'number'
        || typeof v === 'boolean'
        || typeof v === 'symbol'
        || typeof v === 'bigint';
};

var sentinel = {};

var stringify = function stringify(
    object,
    prefix,
    generateArrayPrefix,
    commaRoundTrip,
    allowEmptyArrays,
    strictNullHandling,
    skipNulls,
    encodeDotInKeys,
    encoder,
    filter,
    sort,
    allowDots,
    serializeDate,
    format,
    formatter,
    encodeValuesOnly,
    charset,
    sideChannel
) {
    var obj = object;

    var tmpSc = sideChannel;
    var step = 0;
    var findFlag = false;
    while ((tmpSc = tmpSc.get(sentinel)) !== void undefined && !findFlag) {
        // Where object last appeared in the ref tree
        var pos = tmpSc.get(object);
        step += 1;
        if (typeof pos !== 'undefined') {
            if (pos === step) {
                throw new RangeError('Cyclic object value');
            } else {
                findFlag = true; // Break while
            }
        }
        if (typeof tmpSc.get(sentinel) === 'undefined') {
            step = 0;
        }
    }

    if (typeof filter === 'function') {
        obj = filter(prefix, obj);
    } else if (obj instanceof Date) {
        obj = serializeDate(obj);
    } else if (generateArrayPrefix === 'comma' && isArray(obj)) {
        obj = utils.maybeMap(obj, function (value) {
            if (value instanceof Date) {
                return serializeDate(value);
            }
            return value;
        });
    }

    if (obj === null) {
        if (strictNullHandling) {
            return encoder && !encodeValuesOnly ? encoder(prefix, defaults.encoder, charset, 'key', format) : prefix;
        }

        obj = '';
    }

    if (isNonNullishPrimitive(obj) || utils.isBuffer(obj)) {
        if (encoder) {
            var keyValue = encodeValuesOnly ? prefix : encoder(prefix, defaults.encoder, charset, 'key', format);
            return [formatter(keyValue) + '=' + formatter(encoder(obj, defaults.encoder, charset, 'value', format))];
        }
        return [formatter(prefix) + '=' + formatter(String(obj))];
    }

    var values = [];

    if (typeof obj === 'undefined') {
        return values;
    }

    var objKeys;
    if (generateArrayPrefix === 'comma' && isArray(obj)) {
        // we need to join elements in
        if (encodeValuesOnly && encoder) {
            obj = utils.maybeMap(obj, encoder);
        }
        objKeys = [{ value: obj.length > 0 ? obj.join(',') || null : void undefined }];
    } else if (isArray(filter)) {
        objKeys = filter;
    } else {
        var keys = Object.keys(obj);
        objKeys = sort ? keys.sort(sort) : keys;
    }

    var encodedPrefix = encodeDotInKeys ? String(prefix).replace(/\./g, '%2E') : String(prefix);

    var adjustedPrefix = commaRoundTrip && isArray(obj) && obj.length === 1 ? encodedPrefix + '[]' : encodedPrefix;

    if (allowEmptyArrays && isArray(obj) && obj.length === 0) {
        return adjustedPrefix + '[]';
    }

    for (var j = 0; j < objKeys.length; ++j) {
        var key = objKeys[j];
        var value = typeof key === 'object' && key && typeof key.value !== 'undefined'
            ? key.value
            : obj[key];

        if (skipNulls && value === null) {
            continue;
        }

        var encodedKey = allowDots && encodeDotInKeys ? String(key).replace(/\./g, '%2E') : String(key);
        var keyPrefix = isArray(obj)
            ? typeof generateArrayPrefix === 'function' ? generateArrayPrefix(adjustedPrefix, encodedKey) : adjustedPrefix
            : adjustedPrefix + (allowDots ? '.' + encodedKey : '[' + encodedKey + ']');

        sideChannel.set(object, step);
        var valueSideChannel = getSideChannel();
        valueSideChannel.set(sentinel, sideChannel);
        pushToArray(values, stringify(
            value,
            keyPrefix,
            generateArrayPrefix,
            commaRoundTrip,
            allowEmptyArrays,
            strictNullHandling,
            skipNulls,
            encodeDotInKeys,
            generateArrayPrefix === 'comma' && encodeValuesOnly && isArray(obj) ? null : encoder,
            filter,
            sort,
            allowDots,
            serializeDate,
            format,
            formatter,
            encodeValuesOnly,
            charset,
            valueSideChannel
        ));
    }

    return values;
};

var normalizeStringifyOptions = function normalizeStringifyOptions(opts) {
    if (!opts) {
        return defaults;
    }

    if (typeof opts.allowEmptyArrays !== 'undefined' && typeof opts.allowEmptyArrays !== 'boolean') {
        throw new TypeError('`allowEmptyArrays` option can only be `true` or `false`, when provided');
    }

    if (typeof opts.encodeDotInKeys !== 'undefined' && typeof opts.encodeDotInKeys !== 'boolean') {
        throw new TypeError('`encodeDotInKeys` option can only be `true` or `false`, when provided');
    }

    if (typeof opts.allowReserved !== 'undefined' && typeof opts.allowReserved !== 'boolean') {
        throw new TypeError('`allowReserved` option can only be `true` or `false`, when provided');
    }

    if (opts.encoder !== null && typeof opts.encoder !== 'undefined' && typeof opts.encoder !== 'function') {
        throw new TypeError('Encoder has to be a function.');
    }

    var charset = opts.charset || defaults.charset;
    if (typeof opts.charset !== 'undefined' && opts.charset !== 'utf-8' && opts.charset !== 'iso-8859-1') {
        throw new TypeError('The charset option must be either utf-8, iso-8859-1, or undefined');
    }

    var format = formats['default'];
    if (typeof opts.format !== 'undefined') {
        if (!has.call(formats.formatters, opts.format)) {
            throw new TypeError('Unknown format option provided.');
        }
        format = opts.format;
    }
    var formatter = formats.formatters[format];

    var filter = defaults.filter;
    if (typeof opts.filter === 'function' || isArray(opts.filter)) {
        filter = opts.filter;
    }

    var arrayFormat;
    if (opts.arrayFormat in arrayPrefixGenerators) {
        arrayFormat = opts.arrayFormat;
    } else if ('indices' in opts) {
        arrayFormat = opts.indices ? 'indices' : 'repeat';
    } else {
        arrayFormat = defaults.arrayFormat;
    }

    if ('commaRoundTrip' in opts && typeof opts.commaRoundTrip !== 'boolean') {
        throw new TypeError('`commaRoundTrip` must be a boolean, or absent');
    }

    var allowDots = typeof opts.allowDots === 'undefined' ? opts.encodeDotInKeys === true ? true : defaults.allowDots : !!opts.allowDots;

    return {
        addQueryPrefix: typeof opts.addQueryPrefix === 'boolean' ? opts.addQueryPrefix : defaults.addQueryPrefix,
        allowDots: allowDots,
        allowEmptyArrays: typeof opts.allowEmptyArrays === 'boolean' ? !!opts.allowEmptyArrays : defaults.allowEmptyArrays,
        allowReserved: typeof opts.allowReserved === 'boolean' ? opts.allowReserved : defaults.allowReserved,
        arrayFormat: arrayFormat,
        charset: charset,
        charsetSentinel: typeof opts.charsetSentinel === 'boolean' ? opts.charsetSentinel : defaults.charsetSentinel,
        commaRoundTrip: !!opts.commaRoundTrip,
        delimiter: typeof opts.delimiter === 'undefined' ? defaults.delimiter : opts.delimiter,
        encode: typeof opts.encode === 'boolean' ? opts.encode : defaults.encode,
        encodeDotInKeys: typeof opts.encodeDotInKeys === 'boolean' ? opts.encodeDotInKeys : defaults.encodeDotInKeys,
        encoder: typeof opts.encoder === 'function' ? opts.encoder : defaults.encoder,
        encodeValuesOnly: typeof opts.encodeValuesOnly === 'boolean' ? opts.encodeValuesOnly : defaults.encodeValuesOnly,
        filter: filter,
        format: format,
        formatter: formatter,
        serializeDate: typeof opts.serializeDate === 'function' ? opts.serializeDate : defaults.serializeDate,
        skipNulls: typeof opts.skipNulls === 'boolean' ? opts.skipNulls : defaults.skipNulls,
        sort: typeof opts.sort === 'function' ? opts.sort : null,
        strictNullHandling: typeof opts.strictNullHandling === 'boolean' ? opts.strictNullHandling : defaults.strictNullHandling
    };
};

module.exports = function (object, opts) {
    var obj = object;
    var options = normalizeStringifyOptions(opts);

    var objKeys;
    var filter;

    if (typeof options.filter === 'function') {
        filter = options.filter;
        obj = filter('', obj);
    } else if (isArray(options.filter)) {
        filter = options.filter;
        objKeys = filter;
    }

    var keys = [];

    if (typeof obj !== 'object' || obj === null) {
        return '';
    }

    var generateArrayPrefix = arrayPrefixGenerators[options.arrayFormat];
    var commaRoundTrip = generateArrayPrefix === 'comma' && options.commaRoundTrip;

    var encoder = options.encoder;
    if (options.encode && options.allowReserved && encoder === defaults.encoder) {
        // the default encoder is the only one `allowReserved` may adjust; a
        // user-supplied encoder's output is left untouched
        encoder = makeReservedEncoder(options.delimiter, generateArrayPrefix === 'comma');
    }

    if (!objKeys) {
        objKeys = Object.keys(obj);
    }

    if (options.sort) {
        objKeys.sort(options.sort);
    }

    var sideChannel = getSideChannel();
    for (var i = 0; i < objKeys.length; ++i) {
        var key = objKeys[i];
        var value = obj[key];

        if (options.skipNulls && value === null) {
            continue;
        }
        pushToArray(keys, stringify(
            value,
            key,
            generateArrayPrefix,
            commaRoundTrip,
            options.allowEmptyArrays,
            options.strictNullHandling,
            options.skipNulls,
            options.encodeDotInKeys,
            options.encode ? encoder : null,
            options.filter,
            options.sort,
            options.allowDots,
            options.serializeDate,
            options.format,
            options.formatter,
            options.encodeValuesOnly,
            options.charset,
            sideChannel
        ));
    }

    var joined = keys.join(options.delimiter);
    var prefix = options.addQueryPrefix === true ? '?' : '';

    if (options.charsetSentinel) {
        if (options.charset === 'iso-8859-1') {
            // encodeURIComponent('&#10003;'), the "numeric entity" representation of a checkmark
            prefix += 'utf8=%26%2310003%3B&';
        } else {
            // encodeURIComponent('✓')
            prefix += 'utf8=%E2%9C%93&';
        }
    }

    return joined.length > 0 ? prefix + joined : '';
};
