const workOwner = Symbol.for('studyhub.worker.owner.v1');

export function ownWork(work, owner) {
  Object.defineProperty(work, workOwner, { value: owner, configurable: true });
  return work;
}

export function workOwnedBy(work, owner) { return owner === undefined || work[workOwner] === owner; }
