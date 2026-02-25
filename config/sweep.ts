export interface SweepDropdownField {
  label: string;
  key: string;
  selector: string;
  waitForPostback: boolean;
}

export const sweepFields = {
  store: {
    label: 'Store',
    key: 'ReportViewerControl$ctl04$ctl03$ddValue',
    selector: '#ReportViewerControl_ctl04_ctl03_ddValue',
    waitForPostback: true,
  },
  saleable: {
    label: 'Saleable Assortment',
    key: 'ReportViewerControl$ctl04$ctl05$ddValue',
    selector: '#ReportViewerControl_ctl04_ctl05_ddValue',
    waitForPostback: true,
  },
  orderable: {
    label: 'Orderable Assortment',
    key: 'ReportViewerControl$ctl04$ctl07$ddValue',
    selector: '#ReportViewerControl_ctl04_ctl07_ddValue',
    waitForPostback: true,
  },
  mainSupplierOnly: {
    label: 'Main Supplier Only',
    key: 'ReportViewerControl$ctl04$ctl09$ddValue',
    selector: '#ReportViewerControl_ctl04_ctl09_ddValue',
    waitForPostback: true,
  },
  suppliers: {
    label: 'Suppliers',
    key: 'ReportViewerControl$ctl04$ctl11$ddValue',
    selector: '#ReportViewerControl_ctl04_ctl11_ddValue',
    waitForPostback: true,
  },
  department: {
    label: 'Department',
    key: 'ReportViewerControl$ctl04$ctl15$ddValue',
    selector: '#ReportViewerControl_ctl04_ctl15_ddValue',
    waitForPostback: true,
  },
  subdepartment: {
    label: 'Subdepartment',
    key: 'ReportViewerControl$ctl04$ctl19$ddValue',
    selector: '#ReportViewerControl_ctl04_ctl19_ddValue',
    waitForPostback: true,
  },
  commodity: {
    label: 'Commodity Code',
    key: 'ReportViewerControl$ctl04$ctl23$ddValue',
    selector: '#ReportViewerControl_ctl04_ctl23_ddValue',
    waitForPostback: true,
  },
  family: {
    label: 'Family Group',
    key: 'ReportViewerControl$ctl04$ctl27$ddValue',
    selector: '#ReportViewerControl_ctl04_ctl27_ddValue',
    waitForPostback: false,
  },
  expand: {
    label: 'Expand',
    key: 'ReportViewerControl$ctl04$ctl31$ddValue',
    selector: '#ReportViewerControl_ctl04_ctl31_ddValue',
    waitForPostback: false,
  },
} as const satisfies Record<string, SweepDropdownField>;

export const fixedSelections = {
  saleable: '1',
  orderable: '1',
  mainSupplierOnly: '1',
  suppliers: '3',
  expand: '1',
} as const;

export const startFromSecondSelections = {
  department: true,
  subdepartment: true,
  commodity: true,
  family: true,
} as const;
