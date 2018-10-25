/*
 * Copyright 2018 The NATS Authors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

import test from "ava";
import {SC, startServer, stopServer} from "./helpers/nats_server_control";
import {
    AuthHandler,
    connect,
    NatsConnectionOptions,
} from "../src/nats";
import url from 'url';
import {jsonToNatsConf, writeFile} from "./helpers/nats_conf_utils";
import {next} from 'nuid';
import {join} from 'path';
import {createUser, fromSeed, KeyPair} from 'ts-nkeys';
import {ErrorCode, NatsError} from "../src/error";
import {Lock} from "./helpers/latch";

let CONF_DIR = (process.env.TRAVIS) ? process.env.TRAVIS_BUILD_DIR : process.env.TMPDIR;


test.before(async (t) => {
    let u: KeyPair = createUser();
    let seed = u.getSeed();
    let pk = u.getPublicKey();
    let conf = {
        authorization: {
            users: [
                {nkey: pk}
            ]
        }
    };

    //@ts-ignore
    let fp = join(CONF_DIR, next() + ".conf");
    writeFile(fp, jsonToNatsConf(conf));

    let server = await startServer("localhost:0", ['-DV', '-c', fp]);
    t.context = {server: server, seed: seed};
});

test.after.always((t) => {
    // @ts-ignore
    stopServer(t.context.server);
});


test.failing('connect with nkey', async (t) => {
    t.plan(1);
    let sc = t.context as SC;
    //@ts-ignore
    let kp = fromSeed(sc.seed);
    let u = new url.URL(sc.server.nats);

    let ah = {} as AuthHandler;

    function sign(seed: KeyPair) {
        return function (data: Buffer): Buffer {
            return seed.sign(data);
        }
    }

    ah.sign = sign(kp);
    ah.id = kp.getPublicKey();

    let nc = await connect({port: parseInt(u.port, 10), authHandler: ah} as NatsConnectionOptions);
    nc.on('connect', () => {
        t.pass();
    });
    await nc.flush();
    nc.close();
});

test.failing('client error reported', async (t) => {
    t.plan(1);
    let sc = t.context as SC;
    let u = new url.URL(sc.server.nats);
    //@ts-ignore
    let ah = {} as AuthHandler;

    function sign() {
        return function (data: Buffer): Buffer {
            throw new Error("testing error");
        }
    }

    ah.sign = sign();
    ah.id = "foo";

    let lock = new Lock();
    let nc = await connect({port: parseInt(u.port, 10), authHandler: ah} as NatsConnectionOptions);
    nc.addListener('error', (ex) => {
        t.is(ex.code, ErrorCode.API_ERROR);
        return lock.unlock();
    });
    return lock.latch;
});

test.failing('wrong user', async (t) => {
    t.plan(1);
    let sc = t.context as SC;
    //@ts-ignore
    let kp = createUser();
    let u = new url.URL(sc.server.nats);

    let ah = {} as AuthHandler;

    function sign(seed: KeyPair) {
        return function (data: Buffer): Buffer {
            return seed.sign(data);
        }
    }

    ah.sign = sign(kp);
    ah.id = kp.getPublicKey();


    let lock = new Lock();
    let nc = await connect({port: parseInt(u.port, 10), authHandler: ah} as NatsConnectionOptions);
    nc.on('connect', () => {
        t.fail("shouldn't have connected");
        lock.unlock();
    });
    nc.addListener('error', (err) => {
        let ne = err as NatsError;
        t.is(ne.code, ErrorCode.AUTHORIZATION_VIOLATION);
        lock.unlock();
    });
    return lock.latch;
});