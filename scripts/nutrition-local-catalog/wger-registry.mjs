// Repository fixture mappings, NOT a claim about the deployed server's IDs.
// Kept explicit so a complete offline audit remains possible during DNS failure.
// Publication must wait for --metadata with a captured, paginated-complete server
// language/license registry. Unknown IDs never receive a guessed default.
export const repositoryRegistry = {
  verified: false,
  evidence: 'https://github.com/wger-project/wger/tree/master/wger/core/fixtures',
  // Only the fixture IDs explicitly examined in this evaluation are included.
  // Remaining languages stay unresolved until the live registry is supplied.
  languages: [{id:1,short_name:'de'},{id:2,short_name:'en'},{id:12,short_name:'fr'}],
  licenses: [
    {id:1,url:'https://creativecommons.org/licenses/by-sa/3.0/deed.en'},
    {id:2,url:'https://creativecommons.org/licenses/by-sa/4.0/deed.en'},
    {id:3,url:'http://creativecommons.org/publicdomain/zero/1.0/'},
    {id:4,url:'http://creativecommons.org/licenses/by/4.0/'},
    {id:5,url:'https://opendatacommons.org/licenses/odbl/'}
  ]
}
