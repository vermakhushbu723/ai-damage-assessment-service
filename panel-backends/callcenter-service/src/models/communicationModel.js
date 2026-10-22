import { db, nowIso, parseJson } from '../db/database.js';
import { nextSequentialId } from '../utils/ids.js';
import { queue } from '../services/sync.js';

// Communication History rows (table `communications`). Every row is also
// queued for the Admin portal's Communication Logs.

export function insertCommunication(claimId, c) {
    const id = nextSequentialId('communications', 'COM');
    db.prepare(`INSERT INTO communications (id, claim_id, direction, type, tag, reference, description, sub_description, bullets, attachment_id,
                    person, person_meta, channel, recipient, status, awaiting_response, response_due, letter_id, created_by, at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, claimId, c.direction, c.type, c.tag, c.reference ?? null, c.description, c.subDescription ?? null,
        c.bullets?.length ? JSON.stringify(c.bullets) : null, c.attachmentId ?? null, c.person, c.personMeta ?? null, c.channel,
        c.recipient ?? null, c.status, c.awaitingResponse ? 1 : 0, c.responseDue ?? null, c.letterId ?? null, c.createdBy ?? null, c.at ?? nowIso(),
    );
    queue('commLog', id);
    return id;
}

export function toCommunication(r) {
    return {
        id: r.id,
        direction: r.direction,
        type: r.type,
        tag: r.tag,
        reference: r.reference,
        description: r.description,
        subDescription: r.sub_description,
        bullets: parseJson(r.bullets, null),
        attachmentId: r.attachment_id,
        person: r.person,
        personMeta: r.person_meta,
        channel: r.channel,
        recipient: r.recipient,
        status: r.status,
        awaitingResponse: !!r.awaiting_response,
        responseDue: r.response_due,
        letterId: r.letter_id,
        at: r.at,
    };
}

export const listCommunications = (claimId) =>
    db.prepare('SELECT * FROM communications WHERE claim_id = ? ORDER BY at DESC, id DESC').all(claimId).map(toCommunication);

export const findCommunication = (claimId, id) => {
    const r = db.prepare('SELECT * FROM communications WHERE claim_id = ? AND id = ?').get(claimId, id);
    return r ? toCommunication(r) : null;
};

/** A response arrived for `id`: it no longer waits. */
export function closeAwaiting(claimId, id) {
    db.prepare('UPDATE communications SET awaiting_response = 0 WHERE claim_id = ? AND id = ?').run(claimId, id);
}
