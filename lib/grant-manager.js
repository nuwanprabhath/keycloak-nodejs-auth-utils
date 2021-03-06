/*!
 * Copyright 2014 Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

const URL = require('url');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const querystring = require('querystring');
const Grant = require('./grant');
const Token = require('./token');
var Rotation = require('./rotation');

/**
 * Construct a grant manager.
 *
 * @param {Config} config Config object.
 *
 * @constructor
 */
function GrantManager (config) {
  this.realmUrl = config.realmUrl;
  this.clientId = config.clientId;
  this.secret = config.secret;
  this.publicKey = config.publicKey;
  this.public = config.public;
  this.bearerOnly = config.bearerOnly;
  this.notBefore = 0;
  this.rotation = new Rotation(config);
}

/**
 * Use the direct grant API to obtain a grant from Keycloak.
 *
 * The direct grant API must be enabled for the configured realm
 * for this method to work. This function ostensibly provides a
 * non-interactive, programatic way to login to a Keycloak realm.
 *
 * This method can either accept a callback as the last parameter
 * or return a promise.
 *
 * @param {String} username The username.
 * @param {String} password The cleartext password.
 * @param {Function} callback Optional callback, if not using promises.
 */
GrantManager.prototype.obtainDirectly = function obtainDirectly (username, password, callback) {
  const params = {
    client_id: this.clientId,
    username: username,
    password: password,
    grant_type: 'password'
  };
  const handler = createHandler(this);
  const options = postOptions(this);
  return nodeify(fetch(this, handler, options, params), callback);
};

/**
 * Obtain a grant from a previous interactive login which results in a code.
 *
 * This is typically used by servers which receive the code through a
 * redirect_uri when sending a user to Keycloak for an interactive login.
 *
 * An optional session ID and host may be provided if there is desire for
 * Keycloak to be aware of this information.  They may be used by Keycloak
 * when session invalidation is triggered from the Keycloak console itself
 * during its postbacks to `/k_logout` on the server.
 *
 * This method returns or promise or may optionally take a callback function.
 *
 * @param {String} code The code from a successful login redirected from Keycloak.
 * @param {String} sessionId Optional opaque session-id.
 * @param {String} sessionHost Optional session host for targetted Keycloak console post-backs.
 * @param {Function} callback Optional callback, if not using promises.
 */
GrantManager.prototype.obtainFromCode = function obtainFromCode (request, code, sessionId, sessionHost, callback) {
  const params = {
    client_session_state: sessionId,
    client_session_host: sessionHost,
    code: code,
    grant_type: 'authorization_code',
    client_id: this.clientId,
    redirect_uri: request.session.auth_redirect_uri
  };
  const handler = createHandler(this);
  const options = postOptions(this);

  return nodeify(fetch(this, handler, options, params), callback);
};

/**
 * Ensure that a grant is *fresh*, refreshing if required & possible.
 *
 * If the access_token is not expired, the grant is left untouched.
 *
 * If the access_token is expired, and a refresh_token is available,
 * the grant is refreshed, in place (no new object is created),
 * and returned.
 *
 * If the access_token is expired and no refresh_token is available,
 * an error is provided.
 *
 * The method may either return a promise or take an optional callback.
 *
 * @param {Grant} grant The grant object to ensure freshness of.
 * @param {Function} callback Optional callback if promises are not used.
 */
GrantManager.prototype.ensureFreshness = function ensureFreshness (grant, callback) {
  if (!grant.isExpired()) {
    return nodeify(Promise.resolve(grant), callback);
  }

  if (!grant.refresh_token) {
    return nodeify(Promise.reject(new Error('Unable to refresh without a refresh token')), callback);
  }

  const params = {
    grant_type: 'refresh_token',
    refresh_token: grant.refresh_token.token
  };
  console.log(params.refresh_token);
  const handler = refreshHandler(this, grant);
  const options = postOptions(this);

  return nodeify(fetch(this, handler, options, params), callback);
};

/**
 * Perform live validation of an `access_token` against the Keycloak server.
 *
 * @param {Token|String} token The token to validate.
 * @param {Function} callback Callback function if not using promises.
 *
 * @return {boolean} `false` if the token is invalid, or the same token if valid.
 */
GrantManager.prototype.validateAccessToken = function validateAccessToken (token, callback) {
  let t = token;
  if (typeof token === 'object') {
    t = token.token;
  }
  const params = {
    token: t,
    client_secret: this.secret,
    client_id: this.clientId
  };
  const options = postOptions(this, '/protocol/openid-connect/token/introspect');
  const handler = validationHandler(this, token);

  return nodeify(fetch(this, handler, options, params));
};

GrantManager.prototype.userInfo = function userInfo (token, callback) {
  const url = this.realmUrl + '/protocol/openid-connect/userinfo';
  const options = URL.parse(url);
  options.method = 'GET';

  let t = token;
  if (typeof token === 'object') t = token.token;

  options.headers = {
    'Authorization': 'Bearer ' + t,
    'Accept': 'application/json',
    'X-Client': 'keycloak-nodejs-auth-utils'
  };

  const promise = new Promise((resolve, reject) => {
    const req = getProtocol(options).request(options, (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        return reject('Error fetching account');
      }
      let json = '';
      response.on('data', (d) => (json += d.toString()));
      response.on('end', () => {
        const data = JSON.parse(json);
        if (data.error) reject(data);
        else resolve(data);
      });
    });
    req.end();
  });

  return nodeify(promise, callback);
};

GrantManager.prototype.getAccount = function getAccount () {
  console.error('GrantManager#getAccount is deprecated. See GrantManager#userInfo');
  return this.userInfo.apply(this, arguments);
};

/**
 * Create a `Grant` object from a string of JSON data.
 *
 * This method creates the `Grant` object, including
 * the `access_token`, `refresh_token` and `id_token`
 * if available, and validates each for expiration and
 * against the known public-key of the server.
 *
 * @param {String} rawData The raw JSON string received from the Keycloak server or from a client.
 * @return {Promise} A promise reoslving a grant.
 */
GrantManager.prototype.createGrant = function createGrant (rawData) {
  let grantData = rawData;
  if (typeof rawData !== 'object') grantData = JSON.parse(grantData);

  return this.validateGrant(new Grant({
    access_token: (grantData.access_token ? new Token(grantData.access_token, this.clientId) : undefined),
    refresh_token: (grantData.refresh_token ? new Token(grantData.refresh_token) : undefined),
    id_token: (grantData.id_token ? new Token(grantData.id_token) : undefined),
    expires_in: grantData.expires_in,
    token_type: grantData.token_type,
    __raw: rawData
  }));
};

/**
 * Validate the grant and all tokens contained therein.
 *
 * This method filters a grant (in place), by nulling out
 * any invalid tokens.  After this method returns, the
 * passed in grant will only contain valid tokens.
 *
 * @param {Grant} The grant to validate.
 */
GrantManager.prototype.validateGrant = function validateGrant (grant, callback) {
  var self = this;
  const promise = this.validateToken(grant.access_token).then(token => {
    grant.access_token = token;
  }, () => { console.log('validate access token went wrong'); })
  .then((token) => {
    if (self.bearerOnly) {
      return Promise.resolve(token);
    } else {
      return this.validateToken(grant.refresh_token);
    }
  })
  .then(token => {
    grant.refresh_token = token;
  }, () => { console.log('validate refresh token went wrong'); })
  .then((token) => {
    if (self.bearerOnly) {
      return Promise.resolve(token);
    }
    return this.validateToken(grant.id_token);
  })
  .then(token => {
    grant.id_token = token;
    return grant;
  }, () => { console.log('validate id token went wrong'); })
  .catch(() => { return Promise.reject(); });
  return nodeify(promise, callback);
};

/**
 * Validate a token.
 *
 * This method accepts a token, and either returns the
 * same token object, if valid, else, it returns `undefined`
 * if any of the following errors are seen:
 *
 * - The token was undefined in the first place.
 * - The token is expired.
 * - The token is not expired, but issued before the current *not before* timestamp.
 * - The token signature does not verify against the known realm public-key.
 *
 * @return {Promise} That resolve a token
 */
GrantManager.prototype.validateToken = function validateToken (token) {
  if (!token || token.isExpired() || !token.signed || token.content.iat < this.notBefore) {
    return Promise.reject('invalid token');
  }
  const verify = crypto.createVerify('RSA-SHA256');

  if (this.publicKey) {
    try {
      verify.update(token.signed);
      if (!verify.verify(this.publicKey, token.signature, 'base64')) {
        return this.reject();
      }
    } catch (err) {
      console.error('Misconfigured parameters. Check your keycloak.json file!', err);
      return Promise.reject();
    }
    return Promise.resolve(token);
  }

  // retrieve public KEY
  return this.rotation.getJWK(token.header.kid)
    .then(key => {
      verify.update(token.signed);
      if (!verify.verify(key, token.signature)) {
        return this.reject();
      }
      return token;
    });
};

const getProtocol = (opts) => {
  return opts.protocol === 'https:' ? https : http;
};

const nodeify = (promise, cb) => {
  if (typeof cb !== 'function') return promise;
  return promise.then((res) => cb(null, res)).catch((err) => cb(err));
};

const createHandler = (manager) => (resolve, reject, json) => {
  try {
    resolve(manager.createGrant(json));
  } catch (err) {
    reject(err);
  }
};

const refreshHandler = (manager, grant) => (resolve, reject, json) => {
  manager.createGrant(json)
  .then((grant) => resolve(grant))
  .catch((err) => reject(err));
};

const validationHandler = (manager, token) => (resolve, reject, json) => {
  const data = JSON.parse(json);
  if (!data.active) resolve(false);
  else resolve(token);
};

const postOptions = (manager, path) => {
  const realPath = path || '/protocol/openid-connect/token';
  const opts = URL.parse(manager.realmUrl + realPath);
  opts.headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-Client': 'keycloak-nodejs-auth-utils'
  };
  if (!manager.public) {
    opts.headers['Authorization'] = 'Basic ' + new Buffer(manager.clientId + ':' + manager.secret).toString('base64');
  }
  opts.method = 'POST';
  return opts;
};

const fetch = (manager, handler, options, params) => {
  return new Promise((resolve, reject) => {
    const data = (typeof params === 'string' ? params : querystring.stringify(params));
    options.headers['Content-Length'] = data.length;

    const req = getProtocol(options).request(options, (response) => {
      if (response.statusCode < 200 || response.statusCode > 299) {
        return reject(response.statusCode + ':' + http.STATUS_CODES[ response.statusCode ]);
      }
      let json = '';
      response.on('data', (d) => (json += d.toString()));
      response.on('end', () => {
        handler(resolve, reject, json);
      });
    });

    req.write(data);
    req.end();
  });
};

module.exports = GrantManager;
