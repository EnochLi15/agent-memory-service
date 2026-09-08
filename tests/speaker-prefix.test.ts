import {test} from 'node:test';
import assert from 'node:assert/strict';
import {speakerPrefix} from '../src/text.js';
import {participantIndices,verificationInput} from '../src/verification.js';
import {decodeSourceReferences} from '../src/source-references.js';

const introductions=["Absolutely. Here's the updated version",'Certainly. Updated introduction','Sure. Revised draft','Here is the updated version',"Here's the draft",'Here are the options',"Sure here's the draft"];
test('sentence introductions and here-is headings are not named speakers',()=>{
 for(const name of introductions)assert.equal(speakerPrefix(name+':\nA draft follows.'),null,name);
});
test('initials, conventional titles, apostrophes, hyphens and multilingual names remain speakers',()=>{
 for(const name of ['Dr. Maya Chen','Prof. Élodie Durand','St. John','J. R. R. Tolkien','J.R.R. Tolkien','Mr. O\'Connor','Mrs. Smith','Ms. Chen','Mx. Green','John Smith Jr.','Rev. Smith','Fr. Brown','María-José','张伟','أحمد علي','J. 张伟',"D'Angelo"])
  assert.equal(speakerPrefix(name+': Hello.')?.[1],name,name);
});
test('hyphenated initials remain valid named speakers',()=>{
 assert.equal(speakerPrefix('J.-P. Durand: Hello.')?.[1],'J.-P. Durand');
});
test('unrecognized word-ending periods and malformed abbreviation punctuation are refused',()=>{
 for(const name of ['Absolutely. Updated draft','Draft. Version','Dr.. Smith','J.. Smith','A . Smith'])assert.equal(speakerPrefix(name+': Text.'),null,name);
});
test('existing document-heading boundaries remain unchanged',()=>{
 for(const name of ['Ingredients','Instructions','Steps','Directions','Recipe','Requirements','Output','Summary','Please','My manager','Morgan said'])assert.equal(speakerPrefix(name+': Remove this.'),null,name);
});
test('all user messages remain participants regardless of rejected sentence prefixes',()=>{
 for(const content of introductions.map(x=>x+': I changed my preference.')){
  const req={messages:[{role:'user',content},{role:'assistant',content}]} as any;
  assert.deepEqual(participantIndices(req),[0]);
 }
});
test('the classifier keeps real labelled humans and original assistant context in standard coverage',()=>{
 const req={request_id:'r',user_id:'u',session_id:'s',messages:[{role:'user',content:'Please draft an introduction.'},{role:'assistant',content:"Absolutely. Here's the updated version:\nDraft."},{role:'assistant',content:'Dr. Chen: I moved to Paris.'}]} as any;
 const proposal=decodeSourceReferences({message_groups:[{message_index:0,facts:[],operations:[]},{message_index:2,facts:[],operations:[]}]},req);
 const input=verificationInput(req,proposal,[],[]);
 assert.deepEqual(input.PARTICIPANT_INDEX,[0,2]);assert.deepEqual(input.CHECK_SCOPE.message_indices,[0,2]);
 assert.deepEqual(input.NEW_MESSAGES.map(m=>m.content),req.messages.map((m:any)=>m.content));
 assert.throws(()=>decodeSourceReferences({message_groups:[{message_index:0,facts:[],operations:[]}]},req),/every participant/);
});
test('assistant sentence introductions cannot become human source-reference witnesses',()=>{
 const req={messages:[{role:'assistant',content:"Here's the draft: David manages the team."}]} as any;
 assert.throws(()=>decodeSourceReferences({message_groups:[{message_index:0,facts:[{content:'David manages the team.',subject:'David',predicate:'job',value:'manager',source_refs:[[0,0]]}],operations:[]}]},req),/non-human source reference/);
});
