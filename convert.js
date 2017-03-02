const _ = require('underscore');

/**
* Conversion of an RRS output into markdown. This is the real "meat" of the module...
*
*/
exports.to_markdown = (inp, body) => {
	/**********************************************************************/
	/*                        Helper functions                            */
	/**********************************************************************/
	/**
	* Get a 'label', ie, find out if there is a 'XXX:' at the beginning
	* Returns an object {label, content}, where 'label' may be null
	*/
	function get_label(line) {
		let reg = line.trim().match(/^(\w+):(.*)$/)
		if(reg === null) {
			return {
				label: null,
				content: line
			}
		} else {
			let possible_label   = reg[1].trim();
			let possible_content = reg[2].trim();
			// There are some funny cases, however...
			if(["http", "https", "email", "ftp"].includes(possible_label)) {
				// Ignore the label...
				return {
					label:   null,
					content: line
				}
			} else if(possible_label === "...") {
				//this seems to be a recurring error: scribe continuation lines are preceded by
				// "...:" instead of purely "...""
				return {
					label:   null,
					content: "... " + reg[2].trim()
				}
			} else {
				return {
					label:   reg[1].trim(),
					content: reg[2].trim()
				}
			}
		}
	}

	/**
	* Extract a labelled item, ie, something of the form "XXX: YYY", where
	* "XXX:" is the 'label'
	*/
	function get_labelled_item(label, line) {
		let lower = line.content.toLowerCase();
		let label_length = label.length + 1;   // Accounting for the ':' character!
		return lower.startsWith(label+":") === true ? line.content.slice(label_length).trim() : null;
	}

	/**
	* Extract the scribe's nick from the line
	*/
	let get_scribe = (line) => (get_labelled_item("scribenick",line) || get_labelled_item("scribe",line));

	/**
	* Cleanup actions on the incoming body:
	*  - turn the body (which is one giant string) into an array of lines
	*  - remove empty lines
	*  - remove the starting time stamps
	*  - turn lines into objects, separating the nick name and the content
	*  - remove the lines coming from zakim or rrsagent
	*  - remove zakim queue commands
	*  - remove zakim agenda control commands
	*  - remove bot commands ("zakim,", "rrsagent,", etc.)
	*  - remove the "XXX has joined #YYY" type messages
	*/
	function cleanup(body) {
		// (the chaining feature of underscore is really helpful here...)
		return _.chain(body.split(/\n/))
		   .filter((line) => (_.size(line) !== 0))
		   // Remove the starting time stamp, by cutting off until the first space
		   // Note: these parts may have to be redone, possibly through a
		   //  specific helper function, if the script is adapted to a larger
		   //  palette of IRC client loggers, too.
		   .map((line) => line.slice(line.indexOf(' ') + 1))
		   .map((line) => {
			   sp = line.indexOf(' ');
			   retval = {
				   // Note that I remove the '<' and the '>' characters
				   // leaving only the real nickname
				   nick:    line.slice(1,sp-1),
				   content: line.slice(sp+1).trim()
			   };
			   retval.content_lower = retval.content.toLowerCase();
			   return retval;
		   })
		   .filter((line_object) => (line_object.nick !== 'RRSAgent' && line_object.nick !== 'Zakim'))
		   .filter((line_object) => {
			   return !(
				   line_object.content_lower.startsWith("q+")        ||
				   line_object.content_lower.startsWith("q-")        ||
				   line_object.content_lower.startsWith("q?")        ||
				   line_object.content_lower.startsWith("ack")       ||
				   line_object.content_lower.startsWith("agenda+")   ||
				   line_object.content_lower.startsWith("agenda?")   ||
				   line_object.content_lower.startsWith("trackbot,") ||
				   line_object.content_lower.startsWith("zakim,")    ||
				   line_object.content_lower.startsWith("rrsagent,")
			   )
		   })
		   .filter((line_object) => (line_object.content.match(/^\w+ has joined #\w+/) === null))
		   .filter((line_object) => (line_object.content.match(/^\w+ has left #\w+/) === null))
		   // End of the underscore chain, retrieve the final value
		   .value();
	};

	/**
	*  Fill in the header structure with
	*   - present
	*   - regrets
	*   - guests
	*   - chair
	*   - agenda
	*   - meeting
	*   - date
	*   - scribenick
	* All these actions, except for 'scribenick' also remove the corresponding
	* lines from the input.
	*
	* At the end of this process, lines with nick 'trackbot' are also removed
	*/
	// Beware: although using underscore functions, ie, very functional oriented ways, the
	// filters all have side effects in the sense of expanding the 'header structure'. Not
	// very functional but, oh well...
	function set_header(lines) {
		let headers = {
			present: [],
			regrets: [],
			guests:  [],
			chair:   "",
			agenda:  "",
			date:    "",
			scribe:  [],
			meeting: ""
		};

		/**
		* Extract a list of nick names (used for present, regrets, and guests)
		* All of these have a common structure: 'XXX+' means add nicknames, 'XXX:' means set them.
		*/
		// Care should be taken to trim everything, to keep the nick names clean of extra spaces...
		function people(category, line) {
			let lower    = line.content_lower.trim();
			let cutIndex = category.length;
			if(lower.startsWith(category) === true) {
				// bingo, we have to extract the content
				// There are various possibilities, through
				to_add = false
				if(lower.startsWith(category + "+") === true) {
					names = line.content.slice(cutIndex+1).trim().split(',');
					if(names.length === 0 || (names.length === 1 && names[0].length === 0)) {
						names = [line.nick]
					}
					to_add = true
				} else if(lower.startsWith(category + ":") === true) {
					names = line.content.slice(cutIndex+1).trim().split(',');
				} else {
					// This is not a correct usage...
					return false;
				}

				// Add the names to the header entry
				headers[category] = _.union(headers[category], _.map(names, (name) => name.trim()))
				return true;
			} else {
				return false;
			}
		}

		/**
		* Extract single items like "agenda:" or "chairs:"
		*/
		function single_item(category, line) {
			let item = get_labelled_item(category, line);
			if(item !== null) {
				headers[category] = item;
				return true;
			} else {
				return false;
			}
		}

		/**
		* Handle the scribe(s)
		*/
		function handle_scribes(line) {
			let scribenick = get_scribe(line);
			if(scribenick !== null) {
				headers["scribe"].push(scribenick);
			}
			return true;
		}

		// filter out all irc log lines that are related to header information
		let processed_lines = _.chain(lines)
			.filter((line) => !people("present", line))
			.filter((line) => !people("regrets", line))
			.filter((line) => !people("guests", line))
			.filter((line) => !single_item("chair", line))
			.filter((line) => !single_item("agenda", line))
			.filter((line) => !single_item("meeting", line))
			.filter((line) => !single_item("date", line))
			.filter((line) => handle_scribes(line))
			.filter((line) => (line.nick !== 'trackbot'))
			.value();
		return {
			headers: _.mapObject(headers, (val,key) => _.isArray(val) ? val.join(", ") : val),
			lines  : processed_lines
		}
	};

	/**
	* Handle the s/../.. type lines, ie, make changes on the contents
	*/
	function perform_changes(lines) {
		let change_requests    = [];
		let get_change_request = (str) => {
			return str.match(/^s\/([\w ]+)\/([\w ]*)\/{0,1}(g|G){0,1}/) ||
			       str.match(/^s\|([\w ]+)\|([\w ]*)\|{0,1}(g|G){0,1}/)
		};
		const marker           = "----CHANGEREQUESTXYZ----";

		retval = _.chain(lines)
			// Because the change is to work on the preceding values, the
			// array has to be traversed upside down...
			.reverse()
		  	.map((line,index) => {
				// Find the change requests, extract the values to a separate array
				// and place a marker to remove the original request
				// (Removing it right away is not a good idea, because things are based on
				// the array index later...)
				let r = get_change_request(line.content);
	  			if(r !== null) {
	  				// store the regex results
	  				change_requests.push({
	  					lineno : index,
	  					from   : r[1],
	  					to     : r[2],
	  					g      : r[3] === "g",
	  					G      : r[3] === "G",
						valid  : true
	  				});
	  				line.content = marker
	  			}
	  			return line
			})
			.map((line,index) => {
				// See if a line has to be modifed by one of the change requests
				if(line.content !== marker) {
					_.forEach(change_requests, (change) => {
						// One change request: the change should occur
						// - in any case if the 'G' flag is on
						// - if the index is beyond the change request position otherwise
						if(change.valid && line.content.indexOf(change.from) !== -1) {
							if(change.G || index >= change.lineno) {
								// Yep, this is to be changed
								line.content = line.content.replace(change.from, change.to);
							}
							// If this was not a form of 'global' change then its role is done
							// and the request should be invalidated
							if(!(change.G || change.g)) {
								change.valid = false;
							}
						}
					})
				}
				return line
			})
			// Remove the markers
			.filter((line) => (line.content !== marker))
			// return the array into its original order
			.reverse()
			// done:-)
			.value();

		// console.log(change_requests)
		return retval;
	};

	/**
	* Generate the Header part of the minutes: present, guests, regrets, chair, etc.
	*
	* Returns a string with the (markdown encoded) version of the header.
	*
	*/
	function generate_header_md(headers) {
		return `![W3C Logo](https://www.w3.org/Icons/w3c_home)
# Meeting: ${headers.meeting}
**Date:** ${headers.date}

See also the [Agenda]($headers.agenda) and the [IRC Log](${inp})
## Attendees
**Present:** ${headers.present}

**Regrets:** ${headers.regrets}

**Guests:** ${headers.guests}

**Chair:** ${headers.chair}

**Scribe(s):** ${headers.scribe}
`
	}

	/**
	* Generate the real content. This is the real core of the conversion...
	*
	* The function returns a string containing the (markdown version of) the minutes.
	*
	* Following traditions
	*  - the lines that are not written by the scribe are rendered differently (as a quote)
	*  - lines beginning with a "..." or a "…" are considered as "continuation lines" by the scribe;
	*    these are combined into a paragraph
	*  - "Topic:" and "Subtopic:" produce section headers, and a corresponding TOC is also generated
	*/
	function generate_content_md(lines) {
		// this will be the output
		let content_md     = "\n---\n"
		let TOC = "## Content:\n"
		let resolutions = ""
		// let resolutions = "\n---\n### [Resolutions:](id:res)"

		/**
		* Table of content handling: a (Sub)topic's is set a label as well as a reference into a table of content
		* structure that grows as we go.
		* Sections (and the TOC entries) are automatically numbered
		*/
		let counter            = 1;
		let sec_number_level_1 = 0;
		let sec_number_level_2 = 0;
		let numbering          = "";
		let header_level       = "";
		let toc_spaces         = "";
		function add_toc(content, level) {
			if(level === 1) {
				numbering = ++sec_number_level_1;
				sec_number_level_2  = 0;
				header_level = "### ";
				toc_spaces   = "";
			} else {
				numbering = sec_number_level_1 + "." + (++sec_number_level_2);
				header_level = "#### ";
				toc_spaces   = "    ";
			}
			let id = "section" + counter++;
			content_md = content_md.concat("\n\n", `${header_level}[${numbering}. ${content}](id:${id})`)
			TOC = TOC.concat(`${toc_spaces}* [${numbering}. ${content}](#${id})\n`)
		}

		/**
		* Resolution handling: the resolution receives an ID, and a list of resolution is repeated at the end
		*/
		let rcounter = 1;
		function add_resolution(content) {
			let id = "resolution" + rcounter;
			content_md = content_md.concat(`\n\n> [***Resolution #${rcounter}: ${content}***](id:${id})`)
			resolutions = resolutions.concat(`\n* [Resolution #${rcounter}: ${content}](#${id})`)
			rcounter++;
		}

		// "state" variables for the main cycle...
		let current_scribe = ""
		let within_scribed_content = false;
		// The main cycle on the content
		_.forEach(lines, (line_object) => {
			// What is done depends on some context...
			// Do we have a new scribe?
			let scribe = get_scribe(line_object);
			if(scribe !== null) {
				// This is a scribe change command; the current scribe must be updated,
				// and the line ignored
				current_scribe = scribe.toLowerCase();
				return;
			}
			// Separate the label from the rest
			let {label, content} = get_label(line_object.content)

			// First handle special entries that must be handled regardless
			// of whether it was typed in by the scribe or not.
			if(label !== null && label.toLowerCase() === "topic") {
				within_scribed_content = false;
				add_toc(content, 1)
			} else if(label !== null && label.toLowerCase() === "subtopic") {
				within_scribed_content = false;
				add_toc(content, 2)
			} else if(label !== null && ["proposed", "proposal"].includes(label.toLowerCase())) {
				within_scribed_content = false;
				content_md = content_md.concat(`\n\n*(${line_object.nick})* **Proposed resolution: ${content}**`)
			} else if(label !== null && ["resolved", "resolution"].includes(label.toLowerCase())) {
				within_scribed_content = false;
				add_resolution(content)
			} else {
				// Done with the special entries, filter the scribe entries
				if(line_object.nick.toLowerCase() === current_scribe) {
					if(label !== null) {
						// A new person is talking...
						content_md = content_md.concat("\n\n**", label, ":** ", content)
						within_scribed_content = true;
						// All done with the line!
						return;
					} else {
						let dots = content.startsWith("...") ? 3 : (content.startsWith("…") ? 1 : 0);
						if(dots > 0) {
							// This is a continuation line
							if(within_scribed_content) {
								// We are in the middle of a full paragraph for one person, safe to simply add
								// the text to the previous line without any further ado
								content_md = content_md.concat(" ", content.slice(dots))
							} else {
								// For some reasons, there was a previous line that interrupted the normal flow,
								// a new paragraph should be started
								content_md = content_md.concat("\n\n", content.slice(dots))
								within_scribed_content = true;
							}
						}
					}
				} else {
					within_scribed_content = false;
					// This is a fall back: somebody (not the scribe) makes a note on IRC
					content_md = content_md.concat("\n\n> *", line_object.nick, "*: ", line_object.content)
				}
			}
		});

		// Endgame: pulling the TOC, the real minutes and, possibly, the resolutions together
		if(rcounter > 1) {
			// There has been at least one resolution
			TOC = TOC.concat(`* [${++sec_number_level_1}. Resolutions](#res)\n`)
			return TOC + content_md + `\n---\n### [${sec_number_level_1}. Resolutions](id:res)` + resolutions
		} else {
			return TOC + content_md
		}
	}


	// The real steps...
	// 1. cleanup the content, ie, remove the bot commands and the like
	// 2. separate the header information (present, chair, date, etc)
	//    from the 'real' content. That real content is stored in an array
	//    {nick, content} structures
	let {headers, lines} = set_header(cleanup(body));

	// 3. Perform changes, ie, execute on requests of the "s/.../.../" form in the log:
	lines = perform_changes(lines)

	// 4. Generate the header part of the minutes (using the 'headers' object)
	// 5. Generate the content part, that also includes the TOC and the list of resolutions
	//    (using the 'lines' array of objects)
	// 6. Return the concatenation of the two
	return (generate_header_md(headers) + generate_content_md(lines))
}
