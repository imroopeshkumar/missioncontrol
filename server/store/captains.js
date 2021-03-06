const redis = require('./redis');
const {
  aerospikeConfig,
  namespace
} = require('../config/aerospike');
const Aerospike = require('aerospike');
const GeoJSON = Aerospike.GeoJSON;
const filter = Aerospike.filter;
const aerospike = Aerospike.client(aerospikeConfig());
const Rx = require('rxjs/Rx');
const config = require('../config');

const MAX_LOCAL_RADIUS = 10e5;

const parseCaptainFromRedis = captain => ({
  id: captain.id,
  model: captain.model,
  icon: captain.icon,
  status: captain.status,
  max_charging_velocity: captain.max_charging_velocity,
  coords: {
    lat: parseFloat(captain.lat),
    long: parseFloat(captain.long)
  },
  missions_completed: parseInt(captain.missions_completed),
  missions_completed_7_days: parseInt(captain.missions_completed_7_days),
});

const parseCaptainsArray = captains =>
  captains.filter(captain => !!captain).map(parseCaptainFromRedis);

const addNewCaptain = captain => {
  // Add to captains
  redis.hmsetAsync(`captains:${captain.id}`,
    'id', captain.id,
    'model', captain.model,
    'icon', captain.icon,
    'max_charging_velocity', captain.max_charging_velocity,
    'missions_completed', captain.missions_completed,
    'missions_completed_7_days', captain.missions_completed_7_days,
    'status', captain.status,
  );

  updateCaptainPosition(captain);

  // Set TTL for vehicles
  setCaptainTTL(captain.id);
  // Send new vehicle to Captain
  // createVehicle(vehicle);
};

const updateCaptainPosition = async (captain, newLong = captain.coords.long, newLat = captain.coords.lat) => {
  const positionId = await redis.incrAsync('next_position_id');
  await Promise.all([
    redis.geoaddAsync('captain_positions', newLong, newLat, captain.id),

    redis.hmsetAsync(`captains:${captain.id}`,
      'long', newLong,
      'lat', newLat,
    ),
    redis.hmsetAsync(`captain_position_history:${positionId}`,
      'long', newLong,
      'lat', newLat,
      'status', captain.status
    ),
    redis.zaddAsync(`captains:${captain.id}:positions`, Date.now(), positionId)
  ]);

};

const setCaptainTTL = captainId =>
  redis.expire(`captains:${captainId}`, config('vehicles_ttl'));

const updateCaptainStatus = async (id, status) => {
  return await redis.hsetAsync(`captains:${id}`, 'status', status);
};

const addNeedTypeForCaptain = async ({
  dav_id,
  need_type,
  region
}) => {
  await redis.saddAsync(`needTypes:${need_type}`, dav_id); // adds this captain davId to the needType
  await addNeedTypeIndexes(need_type);
  await aerospike.connect();
  let key = new Aerospike.Key(namespace, need_type, dav_id);
  let bins = region.global === true ? {
    dav_id: dav_id,
    global: 1,
  } : {
    dav_id: dav_id,
    region: new GeoJSON({
      type: 'AeroCircle',
      coordinates: [
        [region.longitude, region.latitude], Math.min(region.radius, MAX_LOCAL_RADIUS)
      ]
    })
  };
  let policy = new Aerospike.WritePolicy({
    exists: Aerospike.policy.exists.CREATE_OR_REPLACE
  });
  await aerospike.put(key, bins, {
    ttl: region.ttl
  }, policy);
  return dav_id;
};

const addNeedToCaptain = async (davId, needId, ttl=120) => {
  let needs = await getNeeds(davId);
  needs.push(needId);
  await redis.setAsync(`captain_needs_${davId}`, redis.encode(needs), 'EX', ttl);
  return davId;
};

/*
  const addBidToCaptain = async (davId, bidId, ttl=120) => {
  let bids = await getBidIds(davId);
  bids.push(bidId);
  await redis.setAsync(`captain_bids_${davId}`, redis.encode(bids), 'EX', ttl);
  return davId;
};
 */

const getNeeds = async (davId) => {
  return redis.decode(await redis.getAsync(`captain_needs_${davId}`))||[];
};

/*
const getBidIds = async (davId) => {
  return redis.decode(await redis.getAsync(`captain_bids_${davId}`))||[];
};

const getBids = async (davId) => {
  return await Promise.all((await getBidIds(davId)).map(async bidId => await getBid(bidId)));
};
 */
const createIndex = async (set, bin, type) => {
  try {
    await aerospike.connect();
    await aerospike.createIndex({
      ns: namespace,
      set: set,
      bin: bin,
      index: `idx_${namespace}_${set}_${bin}`,
      datatype: type
    });
  } catch (error) {
    if (error.message.includes('Index with the same name already exists')) {
      return;
    } else {
      console.log(error);
      throw error;
    }
  }
};

const addNeedTypeIndexes = async (needType) => {
  await createIndex(needType, 'region', Aerospike.indexDataType.GEO2DSPHERE);
  await createIndex(needType, 'global', Aerospike.indexDataType.NUMERIC);
};

const getRedisCaptainObject = async id => {
  setCaptainTTL(id);
  return await redis.hgetallAsync(`captains:${id}`);
};

const getCaptain = async davId => {
  let captain = await getRedisCaptainObject(davId);
  return captain ? parseCaptainFromRedis(captain) : null;
};

const getCaptains = async ids =>
  parseCaptainsArray(await Promise.all(ids.map(id => getRedisCaptainObject(id))), );

const getCaptainsForNeedType = (needType, needLocation) => {
  return new Promise(async (resolve, reject) => {
    try {
      let client = await aerospike.connect();
      geoQueryStreamForTerminal(needLocation, needType, client)
        .distinct(davId => davId)
        .toArray()
        .subscribe(async davIds => {
          await (Promise.all(davIds.map((id) => {
            return redis.hgetallAsync(`captains:${id}`);
          })))
            .then(captains =>
              resolve(captains));
        }, (error) => {
          console.error(error);
          resolve([]);
        });
    } catch (err) {
      reject(err);
    }
  });
};

const query = (set, filters) => {
  let subject = new Rx.Subject();
  let query = aerospike.query(namespace, set, {
    filters: filters
  });
  let stream = query.foreach();

  stream.on('data', (record) => {
    subject.next(record);
  });

  stream.on('error', (error) => {
    subject.error(error);
  });

  stream.on('end', () => {
    subject.complete();
  });
  return subject;
};

const geoQueryStreamForTerminal = (terminal, needType) => {
  return Rx.Observable.merge(
    query(needType, [filter.geoContainsPoint('region', terminal.longitude, terminal.latitude)]),
    query(needType, [filter.equal('global', 1)])
  )
    .map(record => record.bins.dav_id);
};

module.exports = {
  addNewCaptain,
  getCaptain,
  getCaptains,
  updateCaptainStatus,
  updateCaptainPosition,
  getCaptainsForNeedType,
  addNeedTypeForCaptain,
  addNeedToCaptain,
  // addBidToCaptain,
  getNeeds,
  // getBids
};
