/*    Copyright 2021-2023 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

'use strict';

const log = require('./logger.js')(__filename);
const rclient = require('../util/redis_manager.js').getRedisClient();
const f = require('./Firewalla.js');
const sysManager = require('./SysManager.js');
const MessageBus = require('./MessageBus.js');
const messageBus = new MessageBus('info')
const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock();

const util = require('util')
const _ = require('lodash');
const Constants = require('./Constants.js');

// TODO: extract common methods like vpnClient() _dnsmasq() from Host, Identity, NetworkProfile, Tag
class Monitorable {

  static metaFieldsJson = []
  static metaFieldsNumber = []

  static instances = {};  // this instances cache can ensure that Host object for each mac will be created only once.
                          // it is necessary because each object will subscribe Host:PolicyChanged message.
                          // this can guarantee the event handler function is run on the correct and unique object.

  static getInstance(guid) { return this.instances[guid] }

  // TODO: mitigate confusion between this.x and this.o.x across devided classes
  static parse(obj) {
    for (const key in obj) {
      if (this.metaFieldsJson.includes(key)) {
        try {
          // sometimes a field got encoded multiple times, this is a safe guard for that situation
          while (_.isString(obj[key])) {
            const o = JSON.parse(obj[key]);
            if (o === obj[key])
              break;
            obj[key] = o;
          }
        } catch (err) {
          log.error('Parsing', key, obj[key])
        }
      }
      if (this.metaFieldsNumber.includes(key)) {
        obj[key] = Number(obj[key])
      }
      if (obj[key] === "null")
        obj[key] = null;
    }
    return obj
  }

  constructor(o) {
    this.o = this.constructor.parse(o)
    this.policy = {};

    if (!this.getUniqueId()) {
      throw new Error('No UID provided')
    }

    // keep in mind that all Monitorables share the same pub/sub client
    messageBus.subscribeOnce(this.constructor.getPolicyChangeCh(), this.getGUID(), this.onPolicyChange.bind(this))

    this.loadPolicyAsync()
  }

  async destroy() {
    messageBus.unsubscribe(this.constructor.getPolicyChangeCh(), this.getGUID())
    if (this.applyPolicyTask)
      clearTimeout(this.applyPolicyTask);
    delete this.constructor.instances[this.getGUID()]
  }

  static getPolicyChangeCh() {
    return this.getClassName() + ':PolicyChanged'
  }

  async onPolicyChange(channel, id, name, obj) {
    this.policy[name] = obj[name]
    log.info(channel, id, obj);
    if (f.isMain()) {
      await sysManager.waitTillIptablesReady()
      this.scheduleApplyPolicy()
    }
  }

  static getUpdateCh() {
    return this.getClassName() + ':Updated'
  }

  async onUpdate() {}

  static getDeleteCh() {
    return this.getClassName() + ':Delete'
  }

  async onDelete() {}

  async update(raw, quick = false) {
    const o = this.constructor.parse(raw)
    Object.keys(o).forEach(key => {
      if (o[key] === undefined)
        delete o[key];
    })

    if (quick)
      Object.assign(this.o, o)
    else
      this.o = o;
  }

  toJson() {
    const policy = Object.assign({}, this.policy); // a copy of this.policy
    for (const type of Object.keys(Constants.TAG_TYPE_MAP)) {
      const config = Constants.TAG_TYPE_MAP[type];
      const policyKey = config.policyKey;
      const tags = policy[policyKey];
      policy[policyKey] = [];
      if (_.isArray(tags)) {
        const TagManager = require('./TagManager.js');
        for (const uid of tags) {
          const tag = TagManager.getTagByUid(uid);
          if (tag)
            policy[policyKey].push(uid);
        }
      }
    }
    return Object.assign(JSON.parse(JSON.stringify(this.o)), {policy})
  }

  getUniqueId() { throw new Error('Not Implemented') }

  getGUID() { return this.getUniqueId() }

  getMetaKey() { throw new Error('Not Implemented') }

  static getClassName() { return this.name }

  getReadableName() {
    return this.getGUID()
  }

  redisfy() {
    const obj = JSON.parse(JSON.stringify(this.o))
    for (const f in obj) {
      // some fields in this.o may be set as string and converted to object/array later in constructor() or update(), need to double-check in case this function is called after the field is set and before it is converted to object/array
      if (this.constructor.metaFieldsJson.includes(f) && !_.isString(this.o[f]) || obj[f] === null || obj[f] === undefined)
        obj[f] = JSON.stringify(obj[f])
    }
    return obj
  }

  async save(fields) {
    let obj = this.redisfy();

    if (fields) {
      // it works if fields represents a single key as string
      obj = _.pick(obj, fields)
    }

    log.debug('Saving', this.getMetaKey(), fields, obj)
    if (Object.keys(obj).length)
      await rclient.hmsetAsync(this.getMetaKey(), obj)
  }

  _getPolicyKey() { throw new Error('Not Implemented') }

  async saveSinglePolicy(name, policy) {
    this.policy[name] = policy
    const key = this._getPolicyKey()
    if (policy === undefined)
      await rclient.hdelAsync(key, name)
    else
      await rclient.hmsetAsync(key, name, JSON.stringify(policy))
  }

  setPolicy(name, data, callback = ()=>{}) {
    return util.callbackify(this.setPolicyAsync).bind(this)(name, data, callback)
  }

  async setPolicyAsync(name, data) {
    // policy should be in sync once object is initialized
    if (!this.policy) await this.loadPolicyAsync();

    if (JSON.stringify(this.policy[name]) == JSON.stringify(data)) {
      log.debug(`${this.constructor.name}:setPolicy:Nochange`, this.getGUID(), name, data);
      return;
    }
    await this.saveSinglePolicy(name, data)

    const obj = {};
    obj[name] = data;

    messageBus.publish(this.constructor.getPolicyChangeCh(), this.getGUID(), name, obj)
    return obj
  }

  static defaultPolicy() {
    return {
      tags: [],
      userTags: [],
      vpnClient: { state: false },
      acl: true,
      dnsmasq: { dnsCaching: true },
      device_service_scan: false,
      adblock: false,
      safeSearch: { state: false },
      family: false,
      unbound: { state: false },
      doh: { state: false },
      ntp_redirect: { state: false },
      monitor: true
    }
  }

  // this is not covering all policies, add/extend as necessary
  async resetPolicy(name) {
    await this.loadPolicyAsync();
    const defaultPolicy = this.constructor.defaultPolicy()

    if (name) {
      if (name in defaultPolicy)
        await this.setPolicyAsync(name, defaultPolicy[name])
    } else {
      for (name in defaultPolicy)
        await this.setPolicyAsync(name, defaultPolicy[name])
    }
  }

  async loadPolicyAsync() {
    const key = this._getPolicyKey();
    const policyData = await rclient.hgetallAsync(key);
    if (policyData) {
      for (let k in policyData) try {
        policyData[k] = JSON.parse(policyData[k]);
      } catch (err) {
        log.error(`Failed to parse policy ${this.getGUID()} ${k} with value "${policyData[k]}"`, err)
      }
    }
    this.policy = policyData || {}
    return this.policy;
  }

  loadPolicy(callback) {
    return util.callbackify(this.loadPolicyAsync).bind(this)(callback || function(){})
  }

  // set a minimal interval for policy enforcement
  scheduleApplyPolicy() {
    if (this.applyPolicyTask)
      clearTimeout(this.applyPolicyTask);
    this.applyPolicyTask = setTimeout(() => {
      this.applyPolicy();
    }, 3000);
  }

  async applyPolicy() {
    await lock.acquire(`LOCK_APPLY_POLICY_${this.getGUID()}`, async () => {
      // policies should be in sync with messageBus, still read here to make sure everything is in sync
      await this.loadPolicyAsync();
      const policy = JSON.parse(JSON.stringify(this.policy));
      const pm = require('./PolicyManager.js');
      await pm.execute(this, this.getUniqueId(), policy);
    }).catch((err) => {
      log.error('Failed to apply policy', this.getGUID(), this.policy, err);
    });
  }

  // policy.profile:
  // nothing needs to be done here.
  // policy gets reloaded each time FlowMonitor.run() is called

  async ipAllocation(policy) { }

  async _dnsmasq(policy) { }

  async aclTimer(policy = {}) {
    if (this._aclTimer)
      clearTimeout(this._aclTimer);
    if (policy.hasOwnProperty("state") && !isNaN(policy.time) && policy.time) {
      const nextState = policy.state;
      if (Number(policy.time) > Date.now() / 1000) {
        this._aclTimer = setTimeout(() => {
          log.info(`Set acl on ${this.getGUID()} to ${nextState} in acl timer`);
          this.setPolicy("acl", nextState);
          this.setPolicy("aclTimer", {});
        }, policy.time * 1000 - Date.now());
      } else {
        // old timer is already expired when the function is invoked, maybe caused by system reboot
        if (!this.policy || !this.policy.acl || this.policy.acl != nextState) {
          log.info(`Set acl on ${this.getGUID()} to ${nextState} immediately in acl timer`);
          this.setPolicy("acl", nextState);
        }
        this.setPolicy("aclTimer", {});
      }
    }
  }

  async qosTimer(policy = {}) {
    if (this._qosTimer)
      clearTimeout(this._qosTimer);
    if (policy.hasOwnProperty("state") && !isNaN(policy.state) && policy.time) {
      const nextState = policy.state;
      if (Number(policy.time) > Date.now() / 1000) {
        this._qosTimer = setTimeout(() => {
          const newPolicy = this.constructor.name === "HostManager" ? Object.assign({}, this.policy && this.policy.qos, {state: nextState}) : nextState;
          log.info(`Set qos on ${this.getGUID()} to ${nextState} in qos timer`);
          this.setPolicy("qos", newPolicy);
          this.setPolicy("qosTimer", {});
        }, policy.time * 1000 - Date.now());
      } else {
        // old timer is already expired when the function is invoked, maybe caused by system reboot
        if (this.constructor.name === "HostManager") {
          if (!this.policy || !this.policy.qos || this.policy.qos.state != nextState) {
            log.info(`Set qos on ${this.getGUID()} to ${nextState} immediately in qos timer`);
            const newPolicy = Object.assign({}, this.policy && this.policy.qos, {state: nextState});
            this.setPolicy("qos", newPolicy);
          }
        } else {
          if (!this.policy || !this.policy.qos || this.policy.qos != nextState) {
            log.info(`Set qos on ${this.getGUID()} to ${nextState} immediately in qos timer`);
            this.setPolicy("qos", nextState);
          }
        }
        this.setPolicy("qosTimer", {});
      }
    }
  }

  async getTags(type = Constants.TAG_TYPE_GROUP) {
    if (!this.policy) await this.loadPolicyAsync()

    const policyKey = _.get(Constants.TAG_TYPE_MAP, [type, "policyKey"]);
    return policyKey && this.policy[policyKey] && this.policy[policyKey].map(String) || [];
  }
}

module.exports = Monitorable;
