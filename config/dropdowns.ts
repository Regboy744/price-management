import type { DropdownStep } from '../src/types.js';

// Goal, scrappe all products data from all stores, from all suppliers, from all Department and sub levesls


// Drop dropDown full scrapping.
// Lets update the way we scrape the data. 
// Now we will sopping over all options:
// Exampple:
//  - We select the Store, first one.
//  - We selec the Saleable Assortment it wil always be 1, from the beginnign to the end.  
//  - We select the Suppliers, it will be always the 3, that is all suppliers, never change. 
//  - We select the Department - From here, we always start from the 2nd, we need to count how many optins has on the dropdow. 
//  - We select the Subdepartment, also from the scond, need to count the dropdowns
//  - We select the Commodity code, also from the second , need to count the dropdowns 
//  - We select the Familly group, also from the second, need to count the fdrop dropdowns 
//  
//
//  - Then, from the last to the first. I mean, we scrappe all families, in the Commodity, all Commodity in the Subdepartment, all Subdepartment in the Department all Department in the store_
//  then go the next store, start everything again. 
//
//  You can create a function s to figure out how many options on the dropdowns  

// Need to add a new column with the store name


const dropdowns: DropdownStep[] = [
  {
    label: 'Select Store',
    key: 'ReportViewerControl$ctl04$ctl03$ddValue',
    selector: '#ReportViewerControl_ctl04_ctl03_ddValue',
    value: '2',
    waitForPostback: true,
  },
  {
    label: 'Orderable Assortment',
    key: 'ReportViewerControl$ctl04$ctl07$ddValue',
    selector: '#ReportViewerControl_ctl04_ctl07_ddValue',
    value: '1',
    waitForPostback: true,
  },
  {
    label: 'Main Supplier Only',
    key: 'ReportViewerControl$ctl04$ctl09$ddValue',
    selector: '#ReportViewerControl_ctl04_ctl09_ddValue',
    value: '1',
    waitForPostback: true,
  },
  {
    label: 'Suppliers',
    key: 'ReportViewerControl$ctl04$ctl11$ddValue',
    selector: '#ReportViewerControl_ctl04_ctl11_ddValue',
    value: '3',
    waitForPostback: true,
  },
  {
    label: 'Department',
    key: 'ReportViewerControl$ctl04$ctl15$ddValue',
    selector: '#ReportViewerControl_ctl04_ctl15_ddValue',
    value: '2',
    waitForPostback: true,
  },
  {
    label: 'Subdepartment',
    key: 'ReportViewerControl$ctl04$ctl19$ddValue',
    selector: '#ReportViewerControl_ctl04_ctl19_ddValue',
    value: '1',
    waitForPostback: true,
  },
  {
    label: 'Commodity Code',
    key: 'ReportViewerControl$ctl04$ctl23$ddValue',
    selector: '#ReportViewerControl_ctl04_ctl23_ddValue',
    value: '1',
    waitForPostback: true,
  },
  {
    label: 'Expand',
    key: 'ReportViewerControl$ctl04$ctl31$ddValue',
    selector: '#ReportViewerControl_ctl04_ctl31_ddValue',
    value: '1',
    waitForPostback: false,
  },
];

export default dropdowns;
