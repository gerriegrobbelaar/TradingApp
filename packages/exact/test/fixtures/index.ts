/**
 * Recorded-shape fixtures written from knowledge of Exact's OData v2 JSON. Field names are
 * listed as "verify" items in docs/decisions/0014-exact-api-assumptions.md. Bodies are raw
 * strings on purpose: the client must see the original number text (1234.5, 1e-7, ...).
 */

export const HOST = "start.exactonline.nl";
export const DIV = 1234567;

export const ME = `{"d":{"results":[{"__metadata":{"uri":"https://${HOST}/api/v1/current/Me(guid'x')","type":"Exact.Web.Api.Models.Me"},"UserID":"11111111-2222-3333-4444-555555555555","UserName":"gerrie","FullName":"Test User","Email":"test@example.com","CurrentDivision":${DIV},"DivisionCustomer":"AAAAAAAA-0000-0000-0000-00000000000C","DivisionCustomerName":" Camelthorn Advisory B.V. "}]}}`;

export const DIVISIONS = `{"d":{"results":[
 {"__metadata":{"uri":"x"},"Code":${DIV},"Description":"Camelthorn Advisory B.V.","Country":"NL","Currency":"EUR","Status":1,"Main":true},
 {"__metadata":{"uri":"x"},"Code":7654321,"Description":"  Second BV ","Country":"GB","Currency":"gbp","Status":1,"Main":false}
]}}`;

export function receivablesPage1(): string {
  return `{"d":{"results":[
 {"ID":"a0000000-0000-0000-0000-000000000001","AccountId":"c0000000-0000-0000-0000-000000000001","AccountCode":"      1001","AccountName":"Acme BV","Amount":1234.5,"CurrencyCode":"EUR","Description":"Invoice 20240001","DueDate":"/Date(1700000000000)/","EntryNumber":24700001,"InvoiceDate":"/Date(1697500800000)/","InvoiceNumber":20240001},
 {"ID":"a0000000-0000-0000-0000-000000000002","AccountId":"c0000000-0000-0000-0000-000000000002","AccountCode":"      1002","AccountName":"Credit Co","Amount":-99.99,"CurrencyCode":"usd","Description":null,"DueDate":null,"EntryNumber":24700002,"InvoiceDate":null,"InvoiceNumber":null}
],"__next":"https://${HOST}/api/v1/${DIV}/read/financial/ReceivablesList?$select=ID,AccountId&$skiptoken=guid'99999999-0000-0000-0000-000000000000'"}}`;
}

export const RECEIVABLES_PAGE2 = `{"d":{"results":[
 {"ID":"a0000000-0000-0000-0000-000000000003","AccountId":"c0000000-0000-0000-0000-000000000003","AccountCode":"1003","AccountName":"Tiny","Amount":1e-7,"CurrencyCode":"EUR","Description":"Dust","DueDate":"/Date(1700000000000)/","EntryNumber":1,"InvoiceDate":"/Date(1700000000000)/","InvoiceNumber":3}
]}}`;

export const PAYABLES = `{"d":{"results":[
 {"ID":"b0000000-0000-0000-0000-000000000001","AccountId":"c0000000-0000-0000-0000-0000000000f1","AccountCode":"2001","AccountName":"Supplier One","Amount":1234567.89,"CurrencyCode":"EUR","Description":"Bill","DueDate":"/Date(1700000000000)/","EntryNumber":5,"InvoiceDate":"/Date(1700000000000)/","InvoiceNumber":77}
]}}`;

export const ACCOUNTS = `{"d":{"results":[
 {"ID":"c0000000-0000-0000-0000-000000000001","Code":"      1001","Name":"Acme BV","Email":"ap@acme.example","VATNumber":"NL001234567B01","Country":"NL","IsSupplier":false,"IsSales":true,"Status":"C"},
 {"ID":"c0000000-0000-0000-0000-0000000000f1","Code":"2001","Name":"Supplier One","Email":"","VATNumber":null,"Country":"DE","IsSupplier":true,"IsSales":false,"Status":""}
]}}`;

export const BANK_ACCOUNTS = `{"d":{"results":[
 {"ID":"d0000000-0000-0000-0000-000000000001","Account":"c0000000-0000-0000-0000-0000000000f1","BankAccount":"nl91 abna 0417 1643 00","BICCode":"ABNANL2A","BankName":"ABN AMRO","Main":true}
]}}`;

export const SYNC_ACCOUNTS = `{"d":{"results":[
 {"ID":"c0000000-0000-0000-0000-000000000001","Code":"1001","Name":"Acme BV","Email":null,"VATNumber":null,"Country":"NL","IsSupplier":false,"IsSales":true,"Status":"C","Timestamp":9007199254740993},
 {"ID":"c0000000-0000-0000-0000-000000000002","Code":"1002","Name":"Other","Email":null,"VATNumber":null,"Country":"BE","IsSupplier":false,"IsSales":true,"Status":"C","Timestamp":9007199254740999}
]}}`;

export const SYNC_RECEIVABLES = `{"d":{"results":[
 {"ID":"a0000000-0000-0000-0000-000000000009","Account":"c0000000-0000-0000-0000-000000000001","AccountCode":"1001","AccountName":"Acme BV","AmountFC":10,"AmountDC":10,"TransactionAmountFC":12.5,"RateFC":1,"IsFullyPaid":false,"Currency":"EUR","Description":"x","DueDate":"/Date(1700000000000)/","EntryNumber":9,"InvoiceDate":"/Date(1700000000000)/","InvoiceNumber":9,"Timestamp":500}
],"__next":"https://${HOST}/api/v1/${DIV}/sync/Cashflow/Receivables?$filter=Timestamp gt 0L&$orderby=Timestamp&$skiptoken=1"}}`;

export const SYNC_RECEIVABLES_2 = `{"d":{"results":[
 {"ID":"a0000000-0000-0000-0000-00000000000a","Account":"c0000000-0000-0000-0000-000000000001","AccountCode":"1001","AccountName":"Acme BV","AmountFC":20.25,"Currency":"EUR","Description":"y","DueDate":null,"EntryNumber":10,"InvoiceDate":null,"InvoiceNumber":10,"Timestamp":700}
]}}`;

export const EMPTY = `{"d":{"results":[]}}`;

export const GL_BALANCES = `{"d":{"results":[
 {"ID":"e1","GLAccount":"f0000000-0000-0000-0000-000000000001","GLAccountCode":"1100","GLAccountDescription":"Bank","ReportingYear":2025,"ReportingPeriod":3,"BalanceType":"B","Amount":-1500.05}
]}}`;

export const ERROR_BODY = `{"error":{"code":"","message":{"lang":"","value":"Bad filter for NL91ABNA0417164300 with Bearer abc.def.ghi"}}}`;

// XML message types follow XML_MESSAGE_SEVERITY (0 error, 1 warning, 2 success, 3 fatal): a
// recollection, not verified. See ADR 0014 item 13.
export const XML_OK = `<?xml version="1.0" encoding="utf-8"?><eExact><Topics><Topic code="MatchSets" count="1"><Data/><Messages><Message type="2"><Description>Created &amp; matched</Description></Message></Messages></Topic></Topics></eExact>`;

export const XML_ERR = `<?xml version="1.0" encoding="utf-8"?><eExact><Topics><Topic code="MatchSets"><Messages><Message type="0"><Description>Entry &lt;12&gt; is already matched</Description></Message><Message type="1"><Description>Warn</Description></Message></Messages></Topic></Topics></eExact>`;
