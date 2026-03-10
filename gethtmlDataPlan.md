# The goal of the information of this file, is get to undertand the html structure, also liked to the file datapage.html located on this project root.

- Goal, scrapoping the html data. 
- Get the data from the table, and structure it in a organizde csv file. 
- Use the best ts practices.
- Be worried about performance. 
- From the html, just grab the element that contains the data we will need. 
- The code already have some configs already done, so before start see what is done, and reuse the logic. 
- This will be muititaned app, that will run in a vps server.
- The clients profille. Will be companies that have one or many stores. 
- This project, we go on all stores and all Department, Sub Department, Commodity Code, Family Group. Look at the logik of the current project, 
there is already a lookp that goes over all steps. 




## Below some html focus. 


### This is the start of the inputs (dropdowns)

 -  The text EAN/PLU means is the table with the data is available to scrappe. 


#### Select Store:

- The user can have one r more stores, is important that the scrapping workings in all stores. The current project already have a logic that runs all stores. take a look to see if it can be reused. 

<select name="ReportViewerControl$ctl04$ctl03$ddValue" onchange="javascript:setTimeout('__doPostBack(\'ReportViewerControl$ctl04$ctl03$ddValue\',\'\')', 0)" id="ReportViewerControl_ctl04_ctl03_ddValue" class="aspNetDisabled" tabindex="1" style="width: 265px;">
											
											<option selected="selected" value="1">241&nbsp;&nbsp;-&nbsp;&nbsp;RIALTO&nbsp;-&nbsp;O'LEARY</option>
											<option value="2">441&nbsp;&nbsp;-&nbsp;&nbsp;CAMDEN&nbsp;ST&nbsp;-&nbsp;O'LEARY</option>
											<option value="3">628&nbsp;&nbsp;-&nbsp;&nbsp;CHARLEMONT&nbsp;STREET&nbsp;-&nbsp;O'LEARY</option>
											<option value="4">1025&nbsp;&nbsp;-&nbsp;&nbsp;PEARSE&nbsp;ST&nbsp;-&nbsp;O'LEARY</option>
											<option value="5">1740&nbsp;&nbsp;-&nbsp;&nbsp;CENTRA&nbsp;POINT&nbsp;CAMPUS</option>

										</select>


#### Orderable Assortment:

-  it will be always Both,  
<select name="ReportViewerControl$ctl04$ctl07$ddValue" onchange="javascript:setTimeout('__doPostBack(\'ReportViewerControl$ctl04$ctl07$ddValue\',\'\')', 0)" id="ReportViewerControl_ctl04_ctl07_ddValue" class="aspNetDisabled" tabindex="1" style="width: 128px;">
											
											<option selected="selected" value="1">Both</option>
											<option value="2">Ticked</option>
											<option value="3">Unticked</option>

										</select>

#### Select Supplier/CC/AC:

- It will be always the Supplier

This element is huge, because it has all suppliers, but here, we will select the value 3 that is the All Suppliers. We also have this logic implemente on this project, just take a look. 



#### Department


- Here, we will have to get all Departments from all stores, so there will be a loop, same for the other leves below. 



<select name="ReportViewerControl$ctl04$ctl15$ddValue" onchange="javascript:setTimeout('__doPostBack(\'ReportViewerControl$ctl04$ctl15$ddValue\',\'\')', 0)" id="ReportViewerControl_ctl04_ctl15_ddValue" class="aspNetDisabled" tabindex="1" style="width: 431px;">
											
											<option selected="selected" value="1">-&nbsp;ALL&nbsp;-</option>
											<option value="2">D0024&nbsp;-&nbsp;GROCERY&nbsp;-&nbsp;&nbsp;IMPULSE</option>
											<option value="3">D0025&nbsp;-&nbsp;GROCERY&nbsp;-&nbsp;EDIBLE</option>
											<option value="4">D0026&nbsp;-&nbsp;GROCERY&nbsp;-&nbsp;NON&nbsp;FOOD</option>
											<option value="5">D0027&nbsp;-&nbsp;BABY&nbsp;&amp;&nbsp;KIDS</option>
											<option value="6">D0028&nbsp;-&nbsp;PERSONAL&nbsp;CARE</option>
											<option value="7">D0029&nbsp;-&nbsp;BEERS/WINES/SPIRITS</option>
											<option value="8">D0031&nbsp;-&nbsp;TOBACCO</option>
											<option value="9">D0032&nbsp;-&nbsp;PRODUCE</option>
											<option value="10">D0033&nbsp;-&nbsp;MEAT,&nbsp;POULTRY&nbsp;&amp;&nbsp;FISH</option>
											<option value="11">D0034&nbsp;-&nbsp;DAIRY</option>
											<option value="12">D0035&nbsp;-&nbsp;BREAD&nbsp;AND&nbsp;CAKES</option>
											<option value="13">D0036&nbsp;-&nbsp;DELI&nbsp;&nbsp;AND&nbsp;&nbsp;FOOD&nbsp;TO&nbsp;GO</option>
											<option value="14">D0037&nbsp;-&nbsp;PROVISIONS&nbsp;&amp;&nbsp;CONVENIENCE</option>
											<option value="15">D0038&nbsp;-&nbsp;FROZEN&nbsp;FOODS</option>
											<option value="16">D0039&nbsp;-&nbsp;NON&nbsp;FOOD&nbsp;-&nbsp;RETAIL</option>
											<option value="17">D0044&nbsp;-&nbsp;NON&nbsp;FOOD&nbsp;-&nbsp;EXPENSE&nbsp;ITEMS&nbsp;&amp;&nbsp;CONSUMER&nbsp;PROMOTIONS</option>
											<option value="18">D0045&nbsp;-&nbsp;FUEL</option>
											<option value="19">D0046&nbsp;-&nbsp;NEWS&nbsp;&amp;&nbsp;MAGS</option>
											<option value="20">D0047&nbsp;-&nbsp;NON&nbsp;FOOD&nbsp;-&nbsp;INSTORE&nbsp;SERVICES</option>

										</select>


#### Sub Department

<select name="ReportViewerControl$ctl04$ctl19$ddValue" onchange="javascript:setTimeout('__doPostBack(\'ReportViewerControl$ctl04$ctl19$ddValue\',\'\')', 0)" id="ReportViewerControl_ctl04_ctl19_ddValue" class="aspNetDisabled" tabindex="1" style="width: 128px;">
											
											<option selected="selected" value="1">-&nbsp;ALL&nbsp;-</option>

										</select>


####  Commodity Code


<select name="ReportViewerControl$ctl04$ctl23$ddValue" onchange="javascript:setTimeout('__doPostBack(\'ReportViewerControl$ctl04$ctl23$ddValue\',\'\')', 0)" id="ReportViewerControl_ctl04_ctl23_ddValue" class="aspNetDisabled" tabindex="1" style="width: 128px;">
											
											<option selected="selected" value="1">-&nbsp;ALL&nbsp;-</option>

										</select>


#### Family Group:


<select name="ReportViewerControl$ctl04$ctl27$ddValue" id="ReportViewerControl_ctl04_ctl27_ddValue" class="aspNetDisabled" tabindex="1" style="width: 128px;">
											
											<option selected="selected" value="1">-&nbsp;ALL&nbsp;-</option>

										</select>


#### Expand

- Will be always the Yes. Value 1 


<select name="ReportViewerControl$ctl04$ctl31$ddValue" id="ReportViewerControl_ctl04_ctl31_ddValue" class="aspNetDisabled" tabindex="1">
											<option selected="selected" value="39a5c5aa-cb00-46ae-a20e-da26475a106f">&lt;Select&nbsp;a&nbsp;Value&gt;</option>
											<option value="1">Yes</option>
											<option value="2">No</option>

										</select>

#### SubmitButton

Also there is a logic, so after finishin the selection Click on View Report. This will take a while, so it is need a confirmation that already also is applied on the  current logic. 


<input type="submit" name="ReportViewerControl$ctl04$ctl00" value="View Report" id="ReportViewerControl_ctl04_ctl00" tabindex="1" class="SubmitButton">





## After clickin on the buttom, wait for the report, then start getting the data. the report can have one or many pages. \


- reports confirmations : This means that the report has finish, but does not mean that there will be data. 

<div style="width:108.59mm;min-width: 108.59mm;">Standard Article Report (R0001)</div>

- The one below, means that there is a table with data. It is the first table column . 

<div style="width:23.93mm;min-width: 23.93mm;">EAN/PLU</div>


Below i guess, i am not sure, it is the entire table structure:





  






