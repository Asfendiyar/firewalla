/*    Copyright 2019-2024 Firewalla Inc.
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
const { exec } = require('child-process-promise');

const maxIpsetQueue = 158;
const ipsetInterval = 3000;
const f = require('./Firewalla.js');
const _ = require('lodash');

let ipsetQueue = [];
let ipsetTimerSet = false;
let ipsetProcessing = false;

// without setName, read all sets and always returns an array
// with setName, read one set and returns either an object or null
async function read(setName, metaOnly = false) {
  const xml2jsonBinary = `${f.getFirewallaHome()}/extension/xml2json/xml2json.${f.getPlatform()}`;
  try {
    const result = await exec(`sudo timeout 120s ipset list ${metaOnly?'-t':''} ${setName||''} -output xml | ${xml2jsonBinary}`, {maxBuffer: 10 * 1024 * 1024})
    const jsonResult = _.get(JSON.parse(result.stdout), 'ipsets.ipset')
    if (Array.isArray(jsonResult))
      return jsonResult
    else if (_.isEmpty(jsonResult)) {
      log.warn('Read: empty response', result.stderr)
      if (setName) return null
      else return []
    } else if (setName) return jsonResult
    else return [ jsonResult ]
  } catch(err) {
    log.error(`Failed to read ipset ${setName} to json`, err.message);
    return []
  }
}

async function readAllIpsets() {
  const jsonResult = await read()
  const result = {};
  for (const set of jsonResult) {
    const name = set.name;
    const elements = [];
    if (set.members && set.members.member) {
      if (_.isArray(set.members.member)) {
        for (const member of set.members.member) {
          if (member.elem)
            elements.push(member.elem);
        }
      } else {
        if (_.isObject(set.members.member)) {
          if (set.members.member.elem)
            elements.push(set.members.member.elem);
        }
      }
    }
    result[name] = elements;
  }
  return result;
}

async function isReferenced(ipset) {
  const listCommand = `sudo ipset list -t ${ipset} | grep References | cut -d ' ' -f 2`;
  const result = await exec(listCommand);
  const referenceCount = result.stdout.trim();
  return referenceCount !== "0";
}

function enqueue(ipsetCmd) {
  if (ipsetCmd != null) {
    ipsetQueue.push(ipsetCmd);
  }
  if (ipsetProcessing == false && ipsetQueue.length > 0 && (ipsetQueue.length > maxIpsetQueue || ipsetCmd == null)) {
    ipsetProcessing = true;
    let _ipsetQueue = JSON.parse(JSON.stringify(ipsetQueue));
    ipsetQueue = [];
    let child = require('child_process').spawn('sudo', ['ipset', 'restore', '-!']);
    child.stdin.setEncoding('utf-8');
    child.on('exit', (code, signal) => {
      ipsetProcessing = false;
      log.info("Control:Ipset:Processing:END", code);
      enqueue(null);
    });
    child.on('error', (code, signal) => {
      ipsetProcessing = false;
      log.info("Control:Ipset:Processing:Error", code);
      enqueue(null);
    });
    let errorOccurred = false;
    child.stderr.on('data', (data) => {
      log.error("ipset restore error: " + data);
    });
    child.stdin.on('error', (err) => {
      errorOccurred = true;
      log.error("Failed to write to stdin", err);
    });
    writeToStdin(0);
    function writeToStdin(i) {
      const stdinReady = child.stdin.write(_ipsetQueue[i] + "\n", (err) => {
        if (err) {
          errorOccurred = true;
          log.error("Failed to write to stdin", err);
        } else {
          if (i == _ipsetQueue.length - 1) {
            child.stdin.end();
          }
        }
      });
      if (!stdinReady) {
        child.stdin.once('drain', () => {
          if (i !== _ipsetQueue.length - 1 && !errorOccurred) {
            writeToStdin(i + 1);
          }
        });
      } else {
        if (i !== _ipsetQueue.length - 1 && !errorOccurred) {
          writeToStdin(i + 1);
        }
      }
    }
    log.info("Control:Ipset:Processing:Launched", _ipsetQueue.length);
  } else {
    if (ipsetTimerSet == false) {
      setTimeout(() => {
        if (ipsetQueue.length > 0) {
          log.info("Control:Ipset:Timer", ipsetQueue.length);
          enqueue(null);
        }
        ipsetTimerSet = false;
      }, ipsetInterval);
      ipsetTimerSet = true;
    }
  }
}

async function destroy(setName) {
  if (setName && !await isReferenced(setName))
    await exec(`sudo ipset destroy ${setName}`);
}

async function flush(setName) {
  if (setName)
    await exec(`sudo ipset flush ${setName}`);
}

// seems that maxelem doesn't really effect memory usage
async function create(name, type, v6 = false, options = {}) {
  let { timeout, hashsize = 128, maxelem = 65536 } = options
  let cmd
  switch(type) {
    case 'bitmap:port':
      cmd = 'range 0-65535';
      break;
    case 'hash:mac':
      cmd = `hashsize ${hashsize} maxelem ${maxelem}`
      break;
    default: {
      let family = 'family inet';
      if (v6) family = family + '6';
      cmd = family + ` hashsize ${hashsize} maxelem ${maxelem}`
    }
  }
  if (Number.isInteger(timeout))
    cmd = `${cmd} timeout ${timeout}`;
  cmd = `sudo ipset create -! ${name} ${type} ${cmd}`
  return exec(cmd)
}

function add(name, target) {
  const cmd = `add -! ${name} ${target}`
  return exec('sudo ipset ' + cmd);
}

function del(name, target) {
  const cmd = `del -! ${name} ${target}`
  return exec('sudo ipset ' + cmd);
}

async function list(name) {
  try {
    const result = await exec(`sudo ipset -S ${name}`);
    const lines = result.stdout.split('\n')
    lines.pop()
    return lines
      .filter(line => line.startsWith('add'))
      .map(str => str.substring(name.length + 5)) // 'add <name> <target>'
  } catch(err) {
    if (err.name == 'ChildProcessError') {
      log.warn(name, err.stderr) // set not exist
      return []
    }

    throw err
  }
}

const spawn = require('child_process').spawn;
let interactiveIpset = null;

function initInteractiveIpset() {
  interactiveIpset = spawn("sudo", ["ipset", "-", "-!"]);
  interactiveIpset.stderr.on('data', (data) => {
    log.error(`Error in interactive ipset stderr`, data.toString());
  });
  interactiveIpset.on('error', (err) => {
    log.error(`Error in interactive ipset`, err);
    initInteractiveIpset();
  });
  interactiveIpset.stdout.on('data', (data) => {});
}
initInteractiveIpset();

async function batchOp(operations) {
  if (!Array.isArray(operations) || operations.length === 0)
    return;
  try {
    interactiveIpset.stdin.write(operations.join('\n') + '\n');
  } catch (err) {
    log.error("Failed to write to ipset stream, will restart ipset stream process", err.message);
    initInteractiveIpset();
  }
}

const CONSTANTS = {
  IPSET_MONITORED_NET: "monitored_net_set",
  IPSET_LAN: "c_lan_set",
  IPSET_ACL_OFF: "acl_off_set",
  IPSET_ACL_OFF_MAC: "acl_off_mac_set",
  IPSET_NO_DNS_BOOST: "no_dns_caching_set",
  IPSET_NO_DNS_BOOST_MAC: "no_dns_caching_mac_set",
  IPSET_QOS_OFF: "qos_off_set",
  IPSET_QOS_OFF_MAC: "qos_off_mac_set",
  IPSET_MATCH_ALL_SET4: "match_all_set4",
  IPSET_MATCH_ALL_SET6: "match_all_set6",
  IPSET_MATCH_DNS_PORT_SET: "match_dns_port_set",
  IPSET_DOCKER_WAN_ROUTABLE: 'docker_wan_routable_net_set',
  IPSET_DOCKER_LAN_ROUTABLE: 'docker_lan_routable_net_set'
}

module.exports = {
  enqueue,
  isReferenced,
  destroy,
  flush,
  create,
  add,
  del,
  list,
  batchOp,
  CONSTANTS,
  read,
  readAllIpsets
}
