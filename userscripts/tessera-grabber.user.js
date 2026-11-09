// ==UserScript==
// @name         Tessera 资源抓取
// @namespace    https://github.com/yangshoulai/tgdrive
// @version      0.24.0
// @description  从网盘、X、YouTube 和其他网页获取文件，发送到 Tessera 离线下载，或在浏览器下载后上传
// @author       yangshoulai
// @license      AGPL-3.0-or-later
// @icon         data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2032%2032%27%3E%3Crect%20width%3D%2732%27%20height%3D%2732%27%20rx%3D%278%27%20fill%3D%27%230b0c13%27%2F%3E%3Crect%20x%3D%275%27%20y%3D%275%27%20width%3D%2710%27%20height%3D%2710%27%20rx%3D%272.4%27%20fill%3D%27%23fff%27%2F%3E%3Crect%20x%3D%275%27%20y%3D%2717%27%20width%3D%2710%27%20height%3D%2710%27%20rx%3D%272.4%27%20fill%3D%27%23fff%27%20fill-opacity%3D%27.6%27%2F%3E%3Crect%20x%3D%2717%27%20y%3D%2717%27%20width%3D%2710%27%20height%3D%2710%27%20rx%3D%272.4%27%20fill%3D%27%23fff%27%20fill-opacity%3D%27.32%27%2F%3E%3Cpolygon%20points%3D%2718.2%2C6.2%2025.8%2C6.2%2025.8%2C13.8%27%20fill%3D%27%23f0a22e%27%20stroke%3D%27%23f0a22e%27%20stroke-width%3D%272.4%27%20stroke-linejoin%3D%27round%27%2F%3E%3Cpath%20d%3D%27M25.1%206.9%2022.2%209.8%27%20stroke%3D%27%23c27a10%27%20stroke-width%3D%271.1%27%20stroke-linecap%3D%27round%27%2F%3E%3C%2Fsvg%3E
// @match        *://*/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_cookie
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_openInTab
// @grant        GM_addElement
// @grant        unsafeWindow
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.openInTab
// @grant        GM.setClipboard
// @grant        GM.xmlHttpRequest
// @grant        GM.addElement
// @inject-into  content
// @connect      *
// ==/UserScript==

/*
 * Copyright (c) 2026 yangshoulai. Original Tessera code retains its MIT notice
 * in userscripts/NOTICE.md; this combined script is distributed under AGPL-3.0-or-later.
 * Cloud-drive adapters are adapted from LinkSwift by 油小猴 and hmjz100,
 * Copyright (c) 2022 hmjz100, AGPL-3.0-or-later.
 * Upstream: https://github.com/hmjz100/LinkSwift
 * Pinned commit: 8283da03e6c78576ebca8b1604161bcd54ade82e (1.1.4).
 * Modified 2026-10-26: extract selection and link resolution; use Tessera UI/GM APIs;
 * bridge read-only selection across isolated worlds and clarify share-page navigation.
 * License and complete source: https://github.com/yangshoulai/tgdrive/tree/main/userscripts
 * Upstream snapshot and update instructions: third_party/linkswift/README.md.
 * This program comes WITHOUT ANY WARRANTY. See userscripts/LICENSE for the full license.
 */

/*
 * Complete licenses for standalone distribution of this userscript.
 *
 * MIT License
 *
 * Copyright (c) 2026 yangshoulai
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 *                     GNU AFFERO GENERAL PUBLIC LICENSE
 *                        Version 3, 19 November 2007
 *
 *  Copyright (C) 2007 Free Software Foundation, Inc. <https://fsf.org/>
 *  Everyone is permitted to copy and distribute verbatim copies
 *  of this license document, but changing it is not allowed.
 *
 *                             Preamble
 *
 *   The GNU Affero General Public License is a free, copyleft license for
 * software and other kinds of works, specifically designed to ensure
 * cooperation with the community in the case of network server software.
 *
 *   The licenses for most software and other practical works are designed
 * to take away your freedom to share and change the works.  By contrast,
 * our General Public Licenses are intended to guarantee your freedom to
 * share and change all versions of a program--to make sure it remains free
 * software for all its users.
 *
 *   When we speak of free software, we are referring to freedom, not
 * price.  Our General Public Licenses are designed to make sure that you
 * have the freedom to distribute copies of free software (and charge for
 * them if you wish), that you receive source code or can get it if you
 * want it, that you can change the software or use pieces of it in new
 * free programs, and that you know you can do these things.
 *
 *   Developers that use our General Public Licenses protect your rights
 * with two steps: (1) assert copyright on the software, and (2) offer
 * you this License which gives you legal permission to copy, distribute
 * and/or modify the software.
 *
 *   A secondary benefit of defending all users' freedom is that
 * improvements made in alternate versions of the program, if they
 * receive widespread use, become available for other developers to
 * incorporate.  Many developers of free software are heartened and
 * encouraged by the resulting cooperation.  However, in the case of
 * software used on network servers, this result may fail to come about.
 * The GNU General Public License permits making a modified version and
 * letting the public access it on a server without ever releasing its
 * source code to the public.
 *
 *   The GNU Affero General Public License is designed specifically to
 * ensure that, in such cases, the modified source code becomes available
 * to the community.  It requires the operator of a network server to
 * provide the source code of the modified version running there to the
 * users of that server.  Therefore, public use of a modified version, on
 * a publicly accessible server, gives the public access to the source
 * code of the modified version.
 *
 *   An older license, called the Affero General Public License and
 * published by Affero, was designed to accomplish similar goals.  This is
 * a different license, not a version of the Affero GPL, but Affero has
 * released a new version of the Affero GPL which permits relicensing under
 * this license.
 *
 *   The precise terms and conditions for copying, distribution and
 * modification follow.
 *
 *                        TERMS AND CONDITIONS
 *
 *   0. Definitions.
 *
 *   "This License" refers to version 3 of the GNU Affero General Public License.
 *
 *   "Copyright" also means copyright-like laws that apply to other kinds of
 * works, such as semiconductor masks.
 *
 *   "The Program" refers to any copyrightable work licensed under this
 * License.  Each licensee is addressed as "you".  "Licensees" and
 * "recipients" may be individuals or organizations.
 *
 *   To "modify" a work means to copy from or adapt all or part of the work
 * in a fashion requiring copyright permission, other than the making of an
 * exact copy.  The resulting work is called a "modified version" of the
 * earlier work or a work "based on" the earlier work.
 *
 *   A "covered work" means either the unmodified Program or a work based
 * on the Program.
 *
 *   To "propagate" a work means to do anything with it that, without
 * permission, would make you directly or secondarily liable for
 * infringement under applicable copyright law, except executing it on a
 * computer or modifying a private copy.  Propagation includes copying,
 * distribution (with or without modification), making available to the
 * public, and in some countries other activities as well.
 *
 *   To "convey" a work means any kind of propagation that enables other
 * parties to make or receive copies.  Mere interaction with a user through
 * a computer network, with no transfer of a copy, is not conveying.
 *
 *   An interactive user interface displays "Appropriate Legal Notices"
 * to the extent that it includes a convenient and prominently visible
 * feature that (1) displays an appropriate copyright notice, and (2)
 * tells the user that there is no warranty for the work (except to the
 * extent that warranties are provided), that licensees may convey the
 * work under this License, and how to view a copy of this License.  If
 * the interface presents a list of user commands or options, such as a
 * menu, a prominent item in the list meets this criterion.
 *
 *   1. Source Code.
 *
 *   The "source code" for a work means the preferred form of the work
 * for making modifications to it.  "Object code" means any non-source
 * form of a work.
 *
 *   A "Standard Interface" means an interface that either is an official
 * standard defined by a recognized standards body, or, in the case of
 * interfaces specified for a particular programming language, one that
 * is widely used among developers working in that language.
 *
 *   The "System Libraries" of an executable work include anything, other
 * than the work as a whole, that (a) is included in the normal form of
 * packaging a Major Component, but which is not part of that Major
 * Component, and (b) serves only to enable use of the work with that
 * Major Component, or to implement a Standard Interface for which an
 * implementation is available to the public in source code form.  A
 * "Major Component", in this context, means a major essential component
 * (kernel, window system, and so on) of the specific operating system
 * (if any) on which the executable work runs, or a compiler used to
 * produce the work, or an object code interpreter used to run it.
 *
 *   The "Corresponding Source" for a work in object code form means all
 * the source code needed to generate, install, and (for an executable
 * work) run the object code and to modify the work, including scripts to
 * control those activities.  However, it does not include the work's
 * System Libraries, or general-purpose tools or generally available free
 * programs which are used unmodified in performing those activities but
 * which are not part of the work.  For example, Corresponding Source
 * includes interface definition files associated with source files for
 * the work, and the source code for shared libraries and dynamically
 * linked subprograms that the work is specifically designed to require,
 * such as by intimate data communication or control flow between those
 * subprograms and other parts of the work.
 *
 *   The Corresponding Source need not include anything that users
 * can regenerate automatically from other parts of the Corresponding
 * Source.
 *
 *   The Corresponding Source for a work in source code form is that
 * same work.
 *
 *   2. Basic Permissions.
 *
 *   All rights granted under this License are granted for the term of
 * copyright on the Program, and are irrevocable provided the stated
 * conditions are met.  This License explicitly affirms your unlimited
 * permission to run the unmodified Program.  The output from running a
 * covered work is covered by this License only if the output, given its
 * content, constitutes a covered work.  This License acknowledges your
 * rights of fair use or other equivalent, as provided by copyright law.
 *
 *   You may make, run and propagate covered works that you do not
 * convey, without conditions so long as your license otherwise remains
 * in force.  You may convey covered works to others for the sole purpose
 * of having them make modifications exclusively for you, or provide you
 * with facilities for running those works, provided that you comply with
 * the terms of this License in conveying all material for which you do
 * not control copyright.  Those thus making or running the covered works
 * for you must do so exclusively on your behalf, under your direction
 * and control, on terms that prohibit them from making any copies of
 * your copyrighted material outside their relationship with you.
 *
 *   Conveying under any other circumstances is permitted solely under
 * the conditions stated below.  Sublicensing is not allowed; section 10
 * makes it unnecessary.
 *
 *   3. Protecting Users' Legal Rights From Anti-Circumvention Law.
 *
 *   No covered work shall be deemed part of an effective technological
 * measure under any applicable law fulfilling obligations under article
 * 11 of the WIPO copyright treaty adopted on 20 December 1996, or
 * similar laws prohibiting or restricting circumvention of such
 * measures.
 *
 *   When you convey a covered work, you waive any legal power to forbid
 * circumvention of technological measures to the extent such circumvention
 * is effected by exercising rights under this License with respect to
 * the covered work, and you disclaim any intention to limit operation or
 * modification of the work as a means of enforcing, against the work's
 * users, your or third parties' legal rights to forbid circumvention of
 * technological measures.
 *
 *   4. Conveying Verbatim Copies.
 *
 *   You may convey verbatim copies of the Program's source code as you
 * receive it, in any medium, provided that you conspicuously and
 * appropriately publish on each copy an appropriate copyright notice;
 * keep intact all notices stating that this License and any
 * non-permissive terms added in accord with section 7 apply to the code;
 * keep intact all notices of the absence of any warranty; and give all
 * recipients a copy of this License along with the Program.
 *
 *   You may charge any price or no price for each copy that you convey,
 * and you may offer support or warranty protection for a fee.
 *
 *   5. Conveying Modified Source Versions.
 *
 *   You may convey a work based on the Program, or the modifications to
 * produce it from the Program, in the form of source code under the
 * terms of section 4, provided that you also meet all of these conditions:
 *
 *     a) The work must carry prominent notices stating that you modified
 *     it, and giving a relevant date.
 *
 *     b) The work must carry prominent notices stating that it is
 *     released under this License and any conditions added under section
 *     7.  This requirement modifies the requirement in section 4 to
 *     "keep intact all notices".
 *
 *     c) You must license the entire work, as a whole, under this
 *     License to anyone who comes into possession of a copy.  This
 *     License will therefore apply, along with any applicable section 7
 *     additional terms, to the whole of the work, and all its parts,
 *     regardless of how they are packaged.  This License gives no
 *     permission to license the work in any other way, but it does not
 *     invalidate such permission if you have separately received it.
 *
 *     d) If the work has interactive user interfaces, each must display
 *     Appropriate Legal Notices; however, if the Program has interactive
 *     interfaces that do not display Appropriate Legal Notices, your
 *     work need not make them do so.
 *
 *   A compilation of a covered work with other separate and independent
 * works, which are not by their nature extensions of the covered work,
 * and which are not combined with it such as to form a larger program,
 * in or on a volume of a storage or distribution medium, is called an
 * "aggregate" if the compilation and its resulting copyright are not
 * used to limit the access or legal rights of the compilation's users
 * beyond what the individual works permit.  Inclusion of a covered work
 * in an aggregate does not cause this License to apply to the other
 * parts of the aggregate.
 *
 *   6. Conveying Non-Source Forms.
 *
 *   You may convey a covered work in object code form under the terms
 * of sections 4 and 5, provided that you also convey the
 * machine-readable Corresponding Source under the terms of this License,
 * in one of these ways:
 *
 *     a) Convey the object code in, or embodied in, a physical product
 *     (including a physical distribution medium), accompanied by the
 *     Corresponding Source fixed on a durable physical medium
 *     customarily used for software interchange.
 *
 *     b) Convey the object code in, or embodied in, a physical product
 *     (including a physical distribution medium), accompanied by a
 *     written offer, valid for at least three years and valid for as
 *     long as you offer spare parts or customer support for that product
 *     model, to give anyone who possesses the object code either (1) a
 *     copy of the Corresponding Source for all the software in the
 *     product that is covered by this License, on a durable physical
 *     medium customarily used for software interchange, for a price no
 *     more than your reasonable cost of physically performing this
 *     conveying of source, or (2) access to copy the
 *     Corresponding Source from a network server at no charge.
 *
 *     c) Convey individual copies of the object code with a copy of the
 *     written offer to provide the Corresponding Source.  This
 *     alternative is allowed only occasionally and noncommercially, and
 *     only if you received the object code with such an offer, in accord
 *     with subsection 6b.
 *
 *     d) Convey the object code by offering access from a designated
 *     place (gratis or for a charge), and offer equivalent access to the
 *     Corresponding Source in the same way through the same place at no
 *     further charge.  You need not require recipients to copy the
 *     Corresponding Source along with the object code.  If the place to
 *     copy the object code is a network server, the Corresponding Source
 *     may be on a different server (operated by you or a third party)
 *     that supports equivalent copying facilities, provided you maintain
 *     clear directions next to the object code saying where to find the
 *     Corresponding Source.  Regardless of what server hosts the
 *     Corresponding Source, you remain obligated to ensure that it is
 *     available for as long as needed to satisfy these requirements.
 *
 *     e) Convey the object code using peer-to-peer transmission, provided
 *     you inform other peers where the object code and Corresponding
 *     Source of the work are being offered to the general public at no
 *     charge under subsection 6d.
 *
 *   A separable portion of the object code, whose source code is excluded
 * from the Corresponding Source as a System Library, need not be
 * included in conveying the object code work.
 *
 *   A "User Product" is either (1) a "consumer product", which means any
 * tangible personal property which is normally used for personal, family,
 * or household purposes, or (2) anything designed or sold for incorporation
 * into a dwelling.  In determining whether a product is a consumer product,
 * doubtful cases shall be resolved in favor of coverage.  For a particular
 * product received by a particular user, "normally used" refers to a
 * typical or common use of that class of product, regardless of the status
 * of the particular user or of the way in which the particular user
 * actually uses, or expects or is expected to use, the product.  A product
 * is a consumer product regardless of whether the product has substantial
 * commercial, industrial or non-consumer uses, unless such uses represent
 * the only significant mode of use of the product.
 *
 *   "Installation Information" for a User Product means any methods,
 * procedures, authorization keys, or other information required to install
 * and execute modified versions of a covered work in that User Product from
 * a modified version of its Corresponding Source.  The information must
 * suffice to ensure that the continued functioning of the modified object
 * code is in no case prevented or interfered with solely because
 * modification has been made.
 *
 *   If you convey an object code work under this section in, or with, or
 * specifically for use in, a User Product, and the conveying occurs as
 * part of a transaction in which the right of possession and use of the
 * User Product is transferred to the recipient in perpetuity or for a
 * fixed term (regardless of how the transaction is characterized), the
 * Corresponding Source conveyed under this section must be accompanied
 * by the Installation Information.  But this requirement does not apply
 * if neither you nor any third party retains the ability to install
 * modified object code on the User Product (for example, the work has
 * been installed in ROM).
 *
 *   The requirement to provide Installation Information does not include a
 * requirement to continue to provide support service, warranty, or updates
 * for a work that has been modified or installed by the recipient, or for
 * the User Product in which it has been modified or installed.  Access to a
 * network may be denied when the modification itself materially and
 * adversely affects the operation of the network or violates the rules and
 * protocols for communication across the network.
 *
 *   Corresponding Source conveyed, and Installation Information provided,
 * in accord with this section must be in a format that is publicly
 * documented (and with an implementation available to the public in
 * source code form), and must require no special password or key for
 * unpacking, reading or copying.
 *
 *   7. Additional Terms.
 *
 *   "Additional permissions" are terms that supplement the terms of this
 * License by making exceptions from one or more of its conditions.
 * Additional permissions that are applicable to the entire Program shall
 * be treated as though they were included in this License, to the extent
 * that they are valid under applicable law.  If additional permissions
 * apply only to part of the Program, that part may be used separately
 * under those permissions, but the entire Program remains governed by
 * this License without regard to the additional permissions.
 *
 *   When you convey a copy of a covered work, you may at your option
 * remove any additional permissions from that copy, or from any part of
 * it.  (Additional permissions may be written to require their own
 * removal in certain cases when you modify the work.)  You may place
 * additional permissions on material, added by you to a covered work,
 * for which you have or can give appropriate copyright permission.
 *
 *   Notwithstanding any other provision of this License, for material you
 * add to a covered work, you may (if authorized by the copyright holders of
 * that material) supplement the terms of this License with terms:
 *
 *     a) Disclaiming warranty or limiting liability differently from the
 *     terms of sections 15 and 16 of this License; or
 *
 *     b) Requiring preservation of specified reasonable legal notices or
 *     author attributions in that material or in the Appropriate Legal
 *     Notices displayed by works containing it; or
 *
 *     c) Prohibiting misrepresentation of the origin of that material, or
 *     requiring that modified versions of such material be marked in
 *     reasonable ways as different from the original version; or
 *
 *     d) Limiting the use for publicity purposes of names of licensors or
 *     authors of the material; or
 *
 *     e) Declining to grant rights under trademark law for use of some
 *     trade names, trademarks, or service marks; or
 *
 *     f) Requiring indemnification of licensors and authors of that
 *     material by anyone who conveys the material (or modified versions of
 *     it) with contractual assumptions of liability to the recipient, for
 *     any liability that these contractual assumptions directly impose on
 *     those licensors and authors.
 *
 *   All other non-permissive additional terms are considered "further
 * restrictions" within the meaning of section 10.  If the Program as you
 * received it, or any part of it, contains a notice stating that it is
 * governed by this License along with a term that is a further
 * restriction, you may remove that term.  If a license document contains
 * a further restriction but permits relicensing or conveying under this
 * License, you may add to a covered work material governed by the terms
 * of that license document, provided that the further restriction does
 * not survive such relicensing or conveying.
 *
 *   If you add terms to a covered work in accord with this section, you
 * must place, in the relevant source files, a statement of the
 * additional terms that apply to those files, or a notice indicating
 * where to find the applicable terms.
 *
 *   Additional terms, permissive or non-permissive, may be stated in the
 * form of a separately written license, or stated as exceptions;
 * the above requirements apply either way.
 *
 *   8. Termination.
 *
 *   You may not propagate or modify a covered work except as expressly
 * provided under this License.  Any attempt otherwise to propagate or
 * modify it is void, and will automatically terminate your rights under
 * this License (including any patent licenses granted under the third
 * paragraph of section 11).
 *
 *   However, if you cease all violation of this License, then your
 * license from a particular copyright holder is reinstated (a)
 * provisionally, unless and until the copyright holder explicitly and
 * finally terminates your license, and (b) permanently, if the copyright
 * holder fails to notify you of the violation by some reasonable means
 * prior to 60 days after the cessation.
 *
 *   Moreover, your license from a particular copyright holder is
 * reinstated permanently if the copyright holder notifies you of the
 * violation by some reasonable means, this is the first time you have
 * received notice of violation of this License (for any work) from that
 * copyright holder, and you cure the violation prior to 30 days after
 * your receipt of the notice.
 *
 *   Termination of your rights under this section does not terminate the
 * licenses of parties who have received copies or rights from you under
 * this License.  If your rights have been terminated and not permanently
 * reinstated, you do not qualify to receive new licenses for the same
 * material under section 10.
 *
 *   9. Acceptance Not Required for Having Copies.
 *
 *   You are not required to accept this License in order to receive or
 * run a copy of the Program.  Ancillary propagation of a covered work
 * occurring solely as a consequence of using peer-to-peer transmission
 * to receive a copy likewise does not require acceptance.  However,
 * nothing other than this License grants you permission to propagate or
 * modify any covered work.  These actions infringe copyright if you do
 * not accept this License.  Therefore, by modifying or propagating a
 * covered work, you indicate your acceptance of this License to do so.
 *
 *   10. Automatic Licensing of Downstream Recipients.
 *
 *   Each time you convey a covered work, the recipient automatically
 * receives a license from the original licensors, to run, modify and
 * propagate that work, subject to this License.  You are not responsible
 * for enforcing compliance by third parties with this License.
 *
 *   An "entity transaction" is a transaction transferring control of an
 * organization, or substantially all assets of one, or subdividing an
 * organization, or merging organizations.  If propagation of a covered
 * work results from an entity transaction, each party to that
 * transaction who receives a copy of the work also receives whatever
 * licenses to the work the party's predecessor in interest had or could
 * give under the previous paragraph, plus a right to possession of the
 * Corresponding Source of the work from the predecessor in interest, if
 * the predecessor has it or can get it with reasonable efforts.
 *
 *   You may not impose any further restrictions on the exercise of the
 * rights granted or affirmed under this License.  For example, you may
 * not impose a license fee, royalty, or other charge for exercise of
 * rights granted under this License, and you may not initiate litigation
 * (including a cross-claim or counterclaim in a lawsuit) alleging that
 * any patent claim is infringed by making, using, selling, offering for
 * sale, or importing the Program or any portion of it.
 *
 *   11. Patents.
 *
 *   A "contributor" is a copyright holder who authorizes use under this
 * License of the Program or a work on which the Program is based.  The
 * work thus licensed is called the contributor's "contributor version".
 *
 *   A contributor's "essential patent claims" are all patent claims
 * owned or controlled by the contributor, whether already acquired or
 * hereafter acquired, that would be infringed by some manner, permitted
 * by this License, of making, using, or selling its contributor version,
 * but do not include claims that would be infringed only as a
 * consequence of further modification of the contributor version.  For
 * purposes of this definition, "control" includes the right to grant
 * patent sublicenses in a manner consistent with the requirements of
 * this License.
 *
 *   Each contributor grants you a non-exclusive, worldwide, royalty-free
 * patent license under the contributor's essential patent claims, to
 * make, use, sell, offer for sale, import and otherwise run, modify and
 * propagate the contents of its contributor version.
 *
 *   In the following three paragraphs, a "patent license" is any express
 * agreement or commitment, however denominated, not to enforce a patent
 * (such as an express permission to practice a patent or covenant not to
 * sue for patent infringement).  To "grant" such a patent license to a
 * party means to make such an agreement or commitment not to enforce a
 * patent against the party.
 *
 *   If you convey a covered work, knowingly relying on a patent license,
 * and the Corresponding Source of the work is not available for anyone
 * to copy, free of charge and under the terms of this License, through a
 * publicly available network server or other readily accessible means,
 * then you must either (1) cause the Corresponding Source to be so
 * available, or (2) arrange to deprive yourself of the benefit of the
 * patent license for this particular work, or (3) arrange, in a manner
 * consistent with the requirements of this License, to extend the patent
 * license to downstream recipients.  "Knowingly relying" means you have
 * actual knowledge that, but for the patent license, your conveying the
 * covered work in a country, or your recipient's use of the covered work
 * in a country, would infringe one or more identifiable patents in that
 * country that you have reason to believe are valid.
 *
 *   If, pursuant to or in connection with a single transaction or
 * arrangement, you convey, or propagate by procuring conveyance of, a
 * covered work, and grant a patent license to some of the parties
 * receiving the covered work authorizing them to use, propagate, modify
 * or convey a specific copy of the covered work, then the patent license
 * you grant is automatically extended to all recipients of the covered
 * work and works based on it.
 *
 *   A patent license is "discriminatory" if it does not include within
 * the scope of its coverage, prohibits the exercise of, or is
 * conditioned on the non-exercise of one or more of the rights that are
 * specifically granted under this License.  You may not convey a covered
 * work if you are a party to an arrangement with a third party that is
 * in the business of distributing software, under which you make payment
 * to the third party based on the extent of your activity of conveying
 * the work, and under which the third party grants, to any of the
 * parties who would receive the covered work from you, a discriminatory
 * patent license (a) in connection with copies of the covered work
 * conveyed by you (or copies made from those copies), or (b) primarily
 * for and in connection with specific products or compilations that
 * contain the covered work, unless you entered into that arrangement,
 * or that patent license was granted, prior to 28 March 2007.
 *
 *   Nothing in this License shall be construed as excluding or limiting
 * any implied license or other defenses to infringement that may
 * otherwise be available to you under applicable patent law.
 *
 *   12. No Surrender of Others' Freedom.
 *
 *   If conditions are imposed on you (whether by court order, agreement or
 * otherwise) that contradict the conditions of this License, they do not
 * excuse you from the conditions of this License.  If you cannot convey a
 * covered work so as to satisfy simultaneously your obligations under this
 * License and any other pertinent obligations, then as a consequence you may
 * not convey it at all.  For example, if you agree to terms that obligate you
 * to collect a royalty for further conveying from those to whom you convey
 * the Program, the only way you could satisfy both those terms and this
 * License would be to refrain entirely from conveying the Program.
 *
 *   13. Remote Network Interaction; Use with the GNU General Public License.
 *
 *   Notwithstanding any other provision of this License, if you modify the
 * Program, your modified version must prominently offer all users
 * interacting with it remotely through a computer network (if your version
 * supports such interaction) an opportunity to receive the Corresponding
 * Source of your version by providing access to the Corresponding Source
 * from a network server at no charge, through some standard or customary
 * means of facilitating copying of software.  This Corresponding Source
 * shall include the Corresponding Source for any work covered by version 3
 * of the GNU General Public License that is incorporated pursuant to the
 * following paragraph.
 *
 *   Notwithstanding any other provision of this License, you have
 * permission to link or combine any covered work with a work licensed
 * under version 3 of the GNU General Public License into a single
 * combined work, and to convey the resulting work.  The terms of this
 * License will continue to apply to the part which is the covered work,
 * but the work with which it is combined will remain governed by version
 * 3 of the GNU General Public License.
 *
 *   14. Revised Versions of this License.
 *
 *   The Free Software Foundation may publish revised and/or new versions of
 * the GNU Affero General Public License from time to time.  Such new versions
 * will be similar in spirit to the present version, but may differ in detail to
 * address new problems or concerns.
 *
 *   Each version is given a distinguishing version number.  If the
 * Program specifies that a certain numbered version of the GNU Affero General
 * Public License "or any later version" applies to it, you have the
 * option of following the terms and conditions either of that numbered
 * version or of any later version published by the Free Software
 * Foundation.  If the Program does not specify a version number of the
 * GNU Affero General Public License, you may choose any version ever published
 * by the Free Software Foundation.
 *
 *   If the Program specifies that a proxy can decide which future
 * versions of the GNU Affero General Public License can be used, that proxy's
 * public statement of acceptance of a version permanently authorizes you
 * to choose that version for the Program.
 *
 *   Later license versions may give you additional or different
 * permissions.  However, no additional obligations are imposed on any
 * author or copyright holder as a result of your choosing to follow a
 * later version.
 *
 *   15. Disclaimer of Warranty.
 *
 *   THERE IS NO WARRANTY FOR THE PROGRAM, TO THE EXTENT PERMITTED BY
 * APPLICABLE LAW.  EXCEPT WHEN OTHERWISE STATED IN WRITING THE COPYRIGHT
 * HOLDERS AND/OR OTHER PARTIES PROVIDE THE PROGRAM "AS IS" WITHOUT WARRANTY
 * OF ANY KIND, EITHER EXPRESSED OR IMPLIED, INCLUDING, BUT NOT LIMITED TO,
 * THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
 * PURPOSE.  THE ENTIRE RISK AS TO THE QUALITY AND PERFORMANCE OF THE PROGRAM
 * IS WITH YOU.  SHOULD THE PROGRAM PROVE DEFECTIVE, YOU ASSUME THE COST OF
 * ALL NECESSARY SERVICING, REPAIR OR CORRECTION.
 *
 *   16. Limitation of Liability.
 *
 *   IN NO EVENT UNLESS REQUIRED BY APPLICABLE LAW OR AGREED TO IN WRITING
 * WILL ANY COPYRIGHT HOLDER, OR ANY OTHER PARTY WHO MODIFIES AND/OR CONVEYS
 * THE PROGRAM AS PERMITTED ABOVE, BE LIABLE TO YOU FOR DAMAGES, INCLUDING ANY
 * GENERAL, SPECIAL, INCIDENTAL OR CONSEQUENTIAL DAMAGES ARISING OUT OF THE
 * USE OR INABILITY TO USE THE PROGRAM (INCLUDING BUT NOT LIMITED TO LOSS OF
 * DATA OR DATA BEING RENDERED INACCURATE OR LOSSES SUSTAINED BY YOU OR THIRD
 * PARTIES OR A FAILURE OF THE PROGRAM TO OPERATE WITH ANY OTHER PROGRAMS),
 * EVEN IF SUCH HOLDER OR OTHER PARTY HAS BEEN ADVISED OF THE POSSIBILITY OF
 * SUCH DAMAGES.
 *
 *   17. Interpretation of Sections 15 and 16.
 *
 *   If the disclaimer of warranty and limitation of liability provided
 * above cannot be given local legal effect according to their terms,
 * reviewing courts shall apply local law that most closely approximates
 * an absolute waiver of all civil liability in connection with the
 * Program, unless a warranty or assumption of liability accompanies a
 * copy of the Program in return for a fee.
 *
 *                      END OF TERMS AND CONDITIONS
 *
 *             How to Apply These Terms to Your New Programs
 *
 *   If you develop a new program, and you want it to be of the greatest
 * possible use to the public, the best way to achieve this is to make it
 * free software which everyone can redistribute and change under these terms.
 *
 *   To do so, attach the following notices to the program.  It is safest
 * to attach them to the start of each source file to most effectively
 * state the exclusion of warranty; and each file should have at least
 * the "copyright" line and a pointer to where the full notice is found.
 *
 *     <one line to give the program's name and a brief idea of what it does.>
 *     Copyright (C) <year>  <name of author>
 *
 *     This program is free software: you can redistribute it and/or modify
 *     it under the terms of the GNU Affero General Public License as published
 *     by the Free Software Foundation, either version 3 of the License, or
 *     (at your option) any later version.
 *
 *     This program is distributed in the hope that it will be useful,
 *     but WITHOUT ANY WARRANTY; without even the implied warranty of
 *     MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *     GNU Affero General Public License for more details.
 *
 *     You should have received a copy of the GNU Affero General Public License
 *     along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * Also add information on how to contact you by electronic and paper mail.
 *
 *   If your software can interact with users remotely through a computer
 * network, you should also make sure that it provides a way for users to
 * get its source.  For example, if your program is a web application, its
 * interface could display a "Source" link that leads users to an archive
 * of the code.  There are many ways you could offer source, and different
 * solutions will be better for different programs; see section 13 for the
 * specific requirements.
 *
 *   You should also get your employer (if you work as a programmer) or school,
 * if any, to sign a "copyright disclaimer" for the program, if necessary.
 * For more information on this, and how to apply and follow the GNU AGPL, see
 * <https://www.gnu.org/licenses/>.
 */

/*
 * 三处入口：右下角悬浮按钮（所有网页）、X 帖子操作栏、YouTube 播放页操作栏。
 * - 资源嗅探：PerformanceObserver 记录页面加载过的视频、音频、M3U8 和常见文件；图片从 DOM 中按尺寸挑选。
 * - 复制：链接，或带 User-Agent、Referer、Cookie 的 curl 命令（Cookie 经 GM_cookie 读取，包含 HttpOnly）。
 * - 保存到 Tessera（两种方式共用一个确认页：保存位置含私密空间、逐项修改文件名）：
 *   服务器下载：调用 /api/v1/downloads/parse-batch（旧版服务器退回 /downloads/parse）与 /api/v1/downloads，由服务器下载；
 *   本地下载：当前浏览器读取直链资源，再通过 PUT /api/v1/files 上传；单文件最多 64 MiB，不支持流媒体列表。
 *   私密空间：面板内嵌 Tessera 安全页面完成解锁，短期授权有效时直接创建下载或上传，私密交互续期、闲置自动上锁。
 * - 发给文件助手：把当前已渲染页面的结构快照（图片候选与分页链接，不含正文）postMessage 给新打开的 Tessera 页面，
 *   可以逐页暂存后一起发送；由用户在 Tessera 的助手对话框里点击发送，不经过访问密钥。
 * Cookie 只放进你复制的命令或发给你自己配置的 Tessera 服务器，不发往其他地方。
 * 兼容两类脚本管理器：Tampermonkey／Violentmonkey 的同步 GM_* API，以及 iOS Userscripts（Safari）只提供的异步 GM.* API；
 * 后者没有 GM_cookie 和菜单命令，启动前先把存储读入内存，未启用的网站保留一个淡化的悬浮按钮作为入口。
 */
(function () {
  "use strict";

  const page = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const MAX_ITEMS = 150;

  // ---------- 脚本管理器兼容层 ----------

  // Tampermonkey／Violentmonkey 提供同步 GM_*；iOS Userscripts 只有异步 GM.*（以及 GM_xmlhttpRequest），没有 GM_cookie 与菜单命令。
  // 存储统一走内存缓存：异步环境启动前一次读入，写入先改缓存再异步保存，其余代码保持同步读写。
  const GMA = typeof GM !== "undefined" ? GM : null;
  const SYNC_STORE = typeof GM_getValue === "function" && typeof GM_setValue === "function";
  const HAS_MENU = typeof GM_registerMenuCommand === "function";
  const STORE_KEYS = ["settings", "sent", "fabPosition", "assistant-pages", "cloud-baidu-token", "cloud-baidu-auth", "private-client"];
  const cache = new Map();
  const gm = {
    get(key, fallback) {
      if (SYNC_STORE) return GM_getValue(key, fallback);
      return cache.has(key) ? cache.get(key) : fallback;
    },
    set(key, value) {
      if (SYNC_STORE) return GM_setValue(key, value);
      cache.set(key, value);
      const done = value === null || value === undefined ? GMA?.deleteValue?.(key) : GMA?.setValue?.(key, value);
      Promise.resolve(done).catch(() => { /* 保存失败时本页仍使用内存中的值 */ });
    },
    /** 异步存储读入内存；切回标签页时重新读取，拿到其他标签页写入的已发送记录与设置。 */
    async load() {
      if (SYNC_STORE || !GMA?.getValue) return;
      await Promise.all(STORE_KEYS.map(async key => {
        try {
          const value = await GMA.getValue(key);
          if (value === undefined) cache.delete(key); else cache.set(key, value);
        } catch { /* 读取失败沿用默认值 */ }
      }));
    },
    openTab(url) {
      if (typeof GM_openInTab === "function") return GM_openInTab(url, { active: true });
      if (GMA?.openInTab) return void Promise.resolve(GMA.openInTab(url, false)).catch(() => window.open(url, "_blank"));
      window.open(url, "_blank");
    },
    copy(text) {
      if (typeof GM_setClipboard === "function") return GM_setClipboard(text, "text");
      if (GMA?.setClipboard) return void Promise.resolve(GMA.setClipboard(text, "text/plain")).catch(() => navigator.clipboard?.writeText(text));
      navigator.clipboard?.writeText(text);
    },
    /** 返回带 abort() 的请求句柄；GM.xmlHttpRequest 返回的 Promise 本身也带 abort。 */
    xhr(details) {
      if (typeof GM_xmlhttpRequest === "function") return GM_xmlhttpRequest(details);
      if (GMA?.xmlHttpRequest) {
        const request = GMA.xmlHttpRequest(details);
        Promise.resolve(request).catch(() => { /* 结果经回调处理 */ });
        return request;
      }
      throw new Error("当前脚本管理器不支持跨域请求，请使用 Tampermonkey、Violentmonkey 或 Userscripts");
    },
    /** Only the built-in, read-only cloud selection reader is injected; no GM APIs or settings enter the page. */
    async pageScript(textContent) {
      if (typeof GM_addElement === "function") return await GM_addElement("script", { textContent });
      if (GMA?.addElement) return await GMA.addElement("script", { textContent });
      const node = document.createElement("script");
      try {
        node.textContent = textContent;
        (document.head || document.documentElement).appendChild(node);
        return node;
      } catch (error) { node.remove(); throw error; }
    },
    menu(label, fn) { return HAS_MENU ? GM_registerMenuCommand(label, fn) : null; },
    unmenu(id) { if (id != null && typeof GM_unregisterMenuCommand === "function") GM_unregisterMenuCommand(id); },
  };

  // ---------- 设置 ----------

  // siteMode：exclude = 所有网站，排除 excludeSites；include = 只在 includeSites 中的网站。两份列表分开保存，切换模式互不覆盖。
  // destination 以 / 结尾（空串为根目录）；destinationPrivate 为 true 时保存到私密空间（需在 Tessera 页面解锁确认）。
  // cloudBatch：每批发送的文件数（网盘文件与网页资源共用，见 batchLimit），默认 100，最多 BATCH_MAX。
  // 存储键沿用早期只用于网盘时的名称，已保存的值继续生效。
  const BATCH_DEFAULT = 100;
  const BATCH_MAX = 500;
  const DEFAULTS = { server: "", key: "", destination: "", destinationPrivate: false, cookies: true, fab: true, view: "list", siteMode: "exclude", excludeSites: [], includeSites: [],
    cloudBatch: BATCH_DEFAULT, hideSmall: true };
  /** 宽或高小于这个像素的图片多是图标、头像与表情：默认隐藏，筛选行里一键显示。 */
  const SMALL_IMAGE = 200;
  const settings = () => ({ ...DEFAULTS, ...gm.get("settings", {}) });
  const saveSettings = value => gm.set("settings", { ...settings(), ...value });

  // ---------- 已发送记录 ----------

  // 发送成功的资源地址持久保存（跨页面、跨标签页），列表里标「已发送」，全选与批量发送时自动跳过；任务失败时移除。
  const SENT_LIMIT = 1000;
  const sentList = () => gm.get("sent", []);
  const isSent = url => sentList().includes(url);
  function markSent(urls, sent = true) {
    const set = new Set(urls);
    const rest = sentList().filter(url => !set.has(url));
    gm.set("sent", sent ? [...rest, ...set].slice(-SENT_LIMIT) : rest);
  }

  // ---------- 显示范围 ----------

  /** 站点规则统一成域名：去掉协议、路径、端口和开头的 *.；一条规则匹配该域名及其所有子域名。无效时返回空串。 */
  function normalizeSite(value) {
    let text = String(value || "").trim().toLowerCase();
    if (!text) return "";
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(text)) {
      try { text = new URL(text).hostname; } catch { return ""; }
    }
    // www. 不算独立站点：去掉后规则同时覆盖裸域名和其他子域名。
    text = text.replace(/^\*\./, "").replace(/[/?#:].*$/, "").replace(/^\.+|\.+$/g, "").replace(/^www\./, "");
    return text && !/[\s*]/.test(text) && text.includes(".") || text === "localhost" ? text : "";
  }
  const currentSite = () => location.hostname.toLowerCase().replace(/^www\./, "");
  const matchesSite = rule => { const host = location.hostname.toLowerCase(); return host === rule || host.endsWith("." + rule); };
  const siteList = value => (value.siteMode === "include" ? value.includeSites : value.excludeSites) || [];

  /** 当前网站是否启用：Tessera 站点始终停用，其余按显示范围判断。 */
  function siteEnabled(value = settings()) {
    if (onTessera()) return false;
    const hit = siteList(value).some(rule => matchesSite(normalizeSite(rule)));
    return value.siteMode === "include" ? hit : !hit;
  }

  /** 面板与菜单里的「在此网站启用／停用」：只改当前模式对应的列表。 */
  function setSiteEnabled(enabled) {
    const value = settings();
    const key = value.siteMode === "include" ? "includeSites" : "excludeSites";
    const keep = (value[key] || []).filter(rule => !matchesSite(normalizeSite(rule)));
    const add = value.siteMode === "include" ? enabled : !enabled;
    saveSettings({ [key]: add ? [...keep, currentSite()] : keep });
    applySiteState();
    toast(enabled ? `已在 ${currentSite()} 上启用` : HAS_MENU ? `已在 ${currentSite()} 上隐藏，可从脚本管理器菜单恢复` : `已在 ${currentSite()} 上隐藏，点淡化的悬浮按钮可重新启用`);
  }

  // ---------- 资源嗅探 ----------

  const EXT = {
    video: /\.(mp4|m4v|mov|webm|mkv|flv|avi)$/i,
    audio: /\.(mp3|m4a|aac|flac|wav|ogg|oga|opus)$/i,
    stream: /\.(m3u8|mpd)$/i,
    image: /\.(jpe?g|png|gif|webp|avif|bmp|heic)$/i,
    file: /\.(zip|rar|7z|tar|gz|pdf|apk|ipa|dmg|exe|msi|iso|epub)$/i,
  };
  const TYPE_LABEL = { video: "视频", audio: "音频", stream: "M3U8", image: "图片", file: "文件" };
  // 已探测的资源一直累积（上限 MAX_ITEMS，超出时丢弃最早的），只有手动「清空」或刷新页面才清除：
  // 弹窗、标签页切换后旧图片离开 DOM，或单页应用换了地址，之前探测到的资源都要保留，方便一次发送多处的文件。
  const items = new Map();
  const clearedUrls = new Set();  // 已手动清空的地址，避免 DOM 扫描或重复请求立即补回
  const listeners = new Set();

  function classify(url, initiator) {
    let parts;
    try { parts = new URL(url, location.href); } catch { return null; }
    if (!/^https?:$/.test(parts.protocol)) return null;
    const path = parts.pathname.toLowerCase();
    // 分片与按范围请求的媒体无法单独下载：YouTube 走平台解析，HLS 分片只保留播放列表。
    if (parts.hostname.endsWith("googlevideo.com") || /\.(m4s|ts)$/.test(path)) return null;
    if (parts.hostname === "video.twimg.com" && /\/(avc1|hevc|mp4a)\//.test(path) && !EXT.stream.test(path)) return null;
    for (const type of ["stream", "video", "audio", "file"]) {
      if (EXT[type].test(path)) return type;
    }
    if (initiator === "video" || initiator === "audio") return initiator;
    return null;
  }

  // 资源大小与图片尺寸按地址缓存（单条帖子等范围视图里的条目不进入 items，也能显示）。
  const resourceMeta = new Map();
  function noteMeta(url, size, dims) {
    const meta = resourceMeta.get(url) || {};
    let changed = false;
    if (size > 0 && !meta.size) { meta.size = size; changed = true; }
    if (dims && dims[0] && dims[1] && !meta.dims) { meta.dims = dims; changed = true; }
    if (changed) { resourceMeta.set(url, meta); syncMeta(url); }
  }
  /** 资源计时里的大小只用于图片与文件：音视频通常按范围请求，计时只反映已加载的一段。跨域且未允许计时的资源为 0。 */
  const timingSize = (entry, type) => type === "image" || type === "file" ? entry.decodedBodySize || entry.encodedBodySize || 0 : 0;

  function remember(url, type, extra = {}) {
    if (url) noteMeta(url, extra.size, extra.dims);
    if (!url || items.has(url) || clearedUrls.has(url)) return false;
    items.set(url, { url, type, time: Date.now(), ...extra });
    while (items.size > MAX_ITEMS) items.delete(items.keys().next().value);
    return true;
  }
  function addItem(url, type, extra = {}) {
    if (remember(url, type, extra)) listeners.forEach(fn => fn());
  }

  let networkObserver = null;
  function observeNetwork() {
    const Observer = page.PerformanceObserver || window.PerformanceObserver;
    if (!Observer || networkObserver) return;
    try {
      networkObserver = new Observer(list => {
        for (const entry of list.getEntries()) {
          const type = classify(entry.name, entry.initiatorType);
          if (type) addItem(entry.name, type, { source: "网络", size: timingSize(entry, type) });
        }
      });
      networkObserver.observe({ type: "resource", buffered: true });
    } catch { networkObserver = null; /* 浏览器不支持资源计时 */ }
    // Safari 扩展的内容脚本环境里观察器可能收不到页面资源：同时定时读取资源计时列表补齐（重复地址由 remember 去重）。
    if (!resourcePoll) resourcePoll = setInterval(pollResources, 2000);
    pollResources();
  }
  let resourcePoll = null, resourceIndex = 0;
  function pollResources() {
    const timeline = page.performance || window.performance;
    let entries;
    try { entries = timeline?.getEntriesByType?.("resource") || []; } catch { return; }
    if (entries.length < resourceIndex) resourceIndex = 0; // 页面清空了资源缓冲区
    let changed = false;
    for (const entry of entries.slice(resourceIndex)) {
      const type = classify(entry.name, entry.initiatorType);
      if (type && remember(entry.name, type, { source: "网络", size: timingSize(entry, type) })) changed = true;
    }
    resourceIndex = entries.length;
    if (changed) listeners.forEach(fn => fn());
  }

  function upgradeImage(src) {
    try {
      const url = new URL(src);
      if (url.hostname === "pbs.twimg.com" && url.pathname.startsWith("/media/")) {
        url.searchParams.set("name", "orig");
        return url.href;
      }
    } catch { /* 忽略无效地址 */ }
    return src;
  }

  /** 打开面板时补充 DOM 中的媒体：<video>/<audio>/<source> 的直链与足够大的图片。 */
  function scanDom(root = document) {
    const found = [];
    root.querySelectorAll("video, audio, source").forEach(node => {
      const src = node.currentSrc || node.src;
      if (src && !src.startsWith("blob:") && !src.startsWith("data:")) {
        const type = classify(src) || (node.tagName === "AUDIO" ? "audio" : "video");
        found.push({ url: src, type, source: "页面" });
      }
    });
    root.querySelectorAll("img").forEach(img => {
      const src = img.currentSrc || img.src;
      if (!src || !/^https?:/.test(src)) return;
      const big = img.naturalWidth >= 320 && img.naturalHeight >= 200;
      const twitter = /pbs\.twimg\.com\/media\//.test(src);
      if (big || twitter) {
        const url = upgradeImage(src);
        // 升级成原图的地址尺寸未知，等列表里的预览图加载后再记录。
        found.push({ url, type: "image", source: "页面", dims: url === src ? [img.naturalWidth, img.naturalHeight] : null });
      }
    });
    return found;
  }

  // ---------- iframe 中的资源 ----------

  // 跨域 iframe 的资源计时与 DOM 只有框架自己读得到，所以脚本也运行在框架里，但框架里只做嗅探：
  // 收到上级的 frame-scan 后才开始记录资源，经 postMessage 逐级交给顶层页面；不挂界面、不注册菜单、不读写 GM 存储与设置。
  // 顶层只接受来自自己子框架的消息并逐字段校验；消息里只有资源地址与元信息，顶层不向框架发送任何数据。
  const IS_TOP = (() => { try { return window.self === window.top; } catch { return false; } })();
  const FRAME_CHANNEL = "tessera-grabber-frames";
  const FRAME_BATCH = 50;
  function childFrames() {
    const frames = [];
    for (const node of document.querySelectorAll("iframe, frame")) {
      try { if (node.contentWindow) frames.push(node.contentWindow); } catch { /* 已移除的框架 */ }
    }
    return frames;
  }
  const fromChild = source => Boolean(source) && childFrames().includes(source);
  function postFrames(message) {
    for (const target of childFrames()) {
      try { target.postMessage({ ...message, channel: FRAME_CHANNEL }, "*"); } catch { /* 框架正在导航 */ }
    }
  }
  /** 校验框架交来的一项资源；Referer 用框架页面的地址（来源站点常按它校验防盗链）。 */
  function frameItem(value) {
    if (!value || typeof value !== "object" || typeof value.url !== "string" || value.url.length > 4096 || !/^https?:\/\//i.test(value.url)
      || !Object.hasOwn(TYPE_LABEL, value.type)) return null;
    const referer = typeof value.referer === "string" && value.referer.length <= 4096 && /^https?:\/\//i.test(value.referer) ? value.referer : "";
    const size = Number.isFinite(value.size) && value.size > 0 ? value.size : 0;
    const dims = Array.isArray(value.dims) && value.dims.length === 2 && value.dims.every(n => Number.isFinite(n) && n > 0) ? [value.dims[0], value.dims[1]] : null;
    return { url: value.url, type: value.type, extra: { source: value.source === "页面" ? "页面" : "网络", size, dims, referer, frame: true } };
  }
  function rememberFrameItems(list) {
    let changed = false;
    for (const value of list.slice(0, FRAME_BATCH)) {
      const item = frameItem(value);
      if (item && remember(item.url, item.type, item.extra)) changed = true;
    }
    return changed;
  }

  // 顶层：启用时每 2 秒通知子框架（新出现或刚导航的框架随之开始嗅探），打开面板时另请框架扫描 DOM。
  let frameTimer = 0, frameDomAt = 0;
  function onFrameItems(event) {
    const data = event.data;
    if (!active || !data || data.channel !== FRAME_CHANNEL || data.type !== "frame-items" || !Array.isArray(data.items) || !fromChild(event.source)) return;
    if (rememberFrameItems(data.items)) listeners.forEach(fn => fn());
  }
  function watchFrames() {
    if (frameTimer) return;
    window.addEventListener("message", onFrameItems);
    frameTimer = setInterval(() => postFrames({ type: "frame-scan" }), 2000);
    postFrames({ type: "frame-scan" });
  }
  function unwatchFrames() {
    if (!frameTimer) return;
    clearInterval(frameTimer);
    frameTimer = 0;
    window.removeEventListener("message", onFrameItems);
    postFrames({ type: "frame-stop" });
  }
  function scanFrameDom() {
    if (!frameTimer || Date.now() - frameDomAt < 1500) return;
    frameDomAt = Date.now();
    postFrames({ type: "frame-scan", dom: true });
  }

  // 框架：只响应父窗口的消息；自己探测到的与下级框架交来的资源一起往上交，每个地址只交一次。
  function frameAgent() {
    let armed = false;
    const sent = new Set();
    const flush = () => {
      if (!armed) return;
      const fresh = [...items.values()].filter(item => !sent.has(item.url));
      if (sent.size > 2000) sent.clear(); // 只防重复发送，顶层自己会去重
      for (let index = 0; index < fresh.length; index += FRAME_BATCH) {
        const chunk = fresh.slice(index, index + FRAME_BATCH);
        chunk.forEach(item => sent.add(item.url));
        const payload = chunk.map(item => {
          const meta = resourceMeta.get(item.url) || {};
          return { url: item.url, type: item.type, source: item.source, size: meta.size || 0, dims: meta.dims || null, referer: item.referer || referer() };
        });
        try { window.parent.postMessage({ channel: FRAME_CHANNEL, type: "frame-items", items: payload }, "*"); } catch { /* 父窗口已离开 */ }
      }
    };
    window.addEventListener("message", event => {
      const data = event.data;
      if (!data || data.channel !== FRAME_CHANNEL) return;
      if (event.source === window.parent && data.type === "frame-scan") {
        if (!armed) { armed = true; listeners.add(flush); observeNetwork(); flush(); }
        if (data.dom) whenReady(() => { for (const item of scanDom()) remember(item.url, item.type, { source: item.source, dims: item.dims }); flush(); });
        postFrames({ type: "frame-scan", dom: Boolean(data.dom) });
      } else if (event.source === window.parent && data.type === "frame-stop" && armed) {
        armed = false;
        listeners.delete(flush);
        networkObserver?.disconnect();
        networkObserver = null;
        clearInterval(resourcePoll);
        resourcePoll = null;
        resourceIndex = 0;
        items.clear();
        sent.clear();
        postFrames({ type: "frame-stop" });
      } else if (armed && data.type === "frame-items" && Array.isArray(data.items) && fromChild(event.source)) {
        if (rememberFrameItems(data.items)) flush();
      }
    });
  }

  // ---------- 页面识别 ----------

  function platformOf(href) {
    let url;
    try { url = new URL(href); } catch { return null; }
    const host = url.hostname.replace(/^(www|mobile|m)\./, "");
    if (host === "x.com" || host === "twitter.com") {
      const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
      if (match) return { platform: "x", label: "X 帖子", url: `https://x.com/${match[1]}/status/${match[2]}`, id: match[2] };
    }
    if (host === "youtube.com" || host === "music.youtube.com") {
      const id = url.pathname === "/watch" ? url.searchParams.get("v") : (url.pathname.match(/^\/shorts\/([\w-]{6,})/) || [])[1];
      if (id) return { platform: "youtube", label: "YouTube 视频", url: `https://www.youtube.com/watch?v=${id}`, id };
    }
    if (host === "youtu.be" && url.pathname.length > 1) {
      const id = url.pathname.slice(1);
      return { platform: "youtube", label: "YouTube 视频", url: `https://www.youtube.com/watch?v=${id}`, id };
    }
    return null;
  }

  // ---------- 内置网盘适配（LinkSwift 1.1.4 / 8283da03；来源映射见 third_party/linkswift） ----------

  const CLOUD_PROVIDERS = [
    ["baidu", "百度网盘", /^(?:pan|yun)\.baidu\.com$/],
    ["aliyun", "阿里云盘", /^(?:www\.)?(?:aliyundrive|alipan)\.com$/],
    ["mcloud", "中国移动云盘", /^(?:yun|caiyun)\.139\.com$/],
    ["tcloud", "天翼云盘", /^cloud\.189\.cn$/],
    ["xunlei", "迅雷云盘", /^pan\.xunlei\.com$/],
    ["guangya", "光鸭云盘", /^www\.guangyapan\.com$/],
    ["quark", "夸克网盘", /^pan\.quark\.cn$/],
    ["uc", "UC 网盘", /^drive\.uc\.cn$/],
    ["123pan", "123 云盘", /^(?:(?:www|login|yun|user|share)\.)?(?:123(?:pan|684|865|952|912)\.com|123pan\.cn)$/],
  ];
  const CLOUD_API_HOSTS = {
    baidu: ["pan.baidu.com", "yun.baidu.com", "openapi.baidu.com"],
    aliyun: ["api.alipan.com", "api.aliyundrive.com"], mcloud: ["personal-kd-njs.yun.139.com"],
    tcloud: ["api.cloud.189.cn"], xunlei: ["api-pan.xunlei.com", "xluser-ssl.xunlei.com"],
    guangya: ["api.guangyapan.com"], quark: ["drive-pc.quark.cn", "drive-social-api.quark.cn"],
    uc: ["pc-api.uc.cn"], "123pan": ["api.123pan.cn"],
  };
  // Same client identities as LinkSwift. API headers go on the GM request that fetches the link;
  // download headers go into the curl handed to the Tessera server.
  const CLOUD_API_HEADERS = {
    baidu: { "User-Agent": "pan.baidu.com" },
    quark: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 QuarkPC/6.9.7.761 QuarkCloudDrivePC/6.9.7.761 quark-cloud-drive/2.5.40" },
    uc: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) uc-cloud-drive/1.8.8 Chrome/100.0.4896.160 Electron/18.3.5.16-b62cf9c50d Safari/537.36 Channel/ucpan_other_ch",
      "Sec-Ch-Ua": '"Not=A?Brand";v="99", "Chromium";v="100", "Google Chrome";v="100"' },
    "123pan": { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) 123pan/3.2.3 Chrome/108.0.5359.215 Electron/22.3.27 Safari/537.36 WebView/1.0",
      "Sec-Ch-Ua": '"Not?A_Brand";v="8", "Chromium";v="108"' },
  };
  // LinkSwift's pacing: files per batch, whether one request carries the whole batch, and a pause between batches.
  const CLOUD_PACE = { baidu: { size: 50, many: true }, aliyun: { size: 3 }, quark: { size: 15, many: true }, uc: { size: 15, many: true } };
  const CLOUD_PAUSE = 1000;
  // 每批文件数由设置「每批文件数」决定（默认 100，网盘文件与网页资源共用）：一批解析完（网盘还要先取直链）才创建任务，
  // 批太大时前面的直链与解析票据（服务器 30 分钟内有效）可能已经过期，所以最多 BATCH_MAX（500）。旧设置或手改的非法值按默认值处理。
  const batchLimit = (value = settings().cloudBatch) => {
    const size = Number(value);
    return Number.isInteger(size) && size >= 1 ? Math.min(BATCH_MAX, size) : BATCH_DEFAULT;
  };
  const CLOUD_DOWNLOAD_UA = {
    baidu: "pan.baidu.com",
    quark: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 QuarkPC/6.9.7.761 QuarkCloudDrivePC/6.9.7.761 quark-cloud-drive/2.5.40",
    uc: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) uc-cloud-drive/1.8.8 Chrome/100.0.4896.160 Electron/18.3.5.16-b62cf9c50d Safari/537.36 Channel/ucpan_other_ch",
  };
  const BAIDU_AUTHORIZE = "https://openapi.baidu.com/oauth/2.0/authorize?response_type=token&scope=basic,netdisk&client_id=omiOnr2tYnN9vSyDErcVFWpPU2mZA7YO&redirect_uri=oob&confirm_login=0";

  function cloudOf(href = location.href) {
    try {
      const url = new URL(href);
      if (url.protocol !== "https:" || url.username || url.password) return null;
      const found = CLOUD_PROVIDERS.find(([, , hosts]) => hosts.test(url.hostname));
      if (!found) return null;
      return { provider: found[0], label: found[1], url: url.href, share: /^\/(?:web\/)?(?:s|share|link|t)(?:\/|$)|shareweb/.test(url.pathname) };
    } catch { return null; }
  }

  const cloudNode = selector => (page.document || document).querySelector?.(selector);
  function cloudStorage(key) {
    try {
      const value = (page.localStorage || localStorage).getItem(key);
      try { return JSON.parse(value); } catch { return value; }
    } catch { return null; }
  }
  function cloudSetStorage(key, value) {
    try { (page.localStorage || localStorage).setItem(key, JSON.stringify(value)); } catch { /* 本页凭据仍可用 */ }
  }
  function cloudCookie(name) {
    const value = document.cookie.split(";").map(part => part.trim()).find(part => part.startsWith(name + "="))?.slice(name.length + 1) || "";
    try { return decodeURIComponent(value); } catch { return value; }
  }

  const CLOUD_LAYOUTS = {
    baidu: ["fs_id", "server_filename", "size", "fs_id server_filename filename size isdir path"],
    aliyun: ["fileId", "name", "size", "fileId driveId name size type"],
    mcloud: ["contentID", "contentName", "contentSize", "contentID contentName contentSize contentSuffix path dirEtag caName"],
    tcloud: ["fileId", "fileName", "size", "fileId fileName size isFolder shareId"],
    xunlei: ["id", "name", "size", "id name size kind"],
    guangya: ["fileId", "fileName", "fileSize", "fileId fileName fileSize resType"],
    quark: ["fid", "file_name", "size", "fid file_name size file stoken share_fid_token"],
    uc: ["fid", "file_name", "size", "fid file_name size file stoken share_fid_token"],
    "123pan": ["FileId", "FileName", "Size", "FileId FileName Size Type Etag S3KeyFlag"],
  };

  /** Self-contained so it can also run in the page realm. Only whitelisted primitive file fields leave it. */
  function cloudReadSelection(view, provider, fields, share) {
    const doc = view.document || document;
    const nodes = selector => {
      const all = [...(doc.querySelectorAll?.(selector) || [])];
      return all.length ? all : [doc.querySelector?.(selector)].filter(Boolean);
    };
    const node = selector => nodes(selector)[0];
    let available = false;
    const list = value => { if (Array.isArray(value)) { available = true; return value; } return []; };
    const keysOf = value => typeof value === "string" ? value.split(",") : Array.isArray(value) ? value
      : value && typeof value.values === "function" ? [...value.values()] : [];
    function reactValues(element) {
      const values = [], visited = new Set();
      const keys = Object.keys(element);
      const direct = element[keys.find(key => key.startsWith("__reactProps$"))];
      if (direct) values.push(direct);
      let fiber = element[keys.find(key => /^(?:__reactFiber\$|__reactInternalInstance\$)/.test(key))];
      for (let depth = 0; fiber && depth < 40 && !visited.has(fiber); depth++) {
        visited.add(fiber);
        // Class components may keep the selection in state and the file list in props.
        const instance = fiber.stateNode || fiber._instance;
        if (instance?.props && instance?.state) values.push({ ...instance.props, ...instance.state });
        for (const value of [instance?.props, instance?.state, fiber.memoizedProps, fiber.pendingProps]) if (value) values.push(value);
        fiber = fiber.return || fiber._currentElement?._owner;
      }
      return values;
    }
    function reactList(selectors, listNames, idKey, selectionNames) {
      let empty = [];
      for (const selector of selectors) for (const element of nodes(selector).slice(0, 8)) {
        const values = reactValues(element);
        for (const props of values) {
          const files = listNames.map(key => props[key]).find(Array.isArray);
          if (provider === "123pan" && props.file?.S3KeyFlag != null) { available = true; return [props.file]; }
          if (!files) continue;
          const selection = value => selectionNames.map(key => value[key]).find(value => value != null) ?? value.rowSelection?.selectedRowKeys;
          const selected = selection(props) ?? values.map(selection).find(value => value != null);
          if (selected == null && !(provider === "123pan" && files.some(item => item.checked != null))) continue;
          available = true;
          const ids = new Set(keysOf(selected).map(String));
          const token = values.map(value => value.stoken).find(value => typeof value === "string" && value) || "";
          const result = files.filter(item => provider === "123pan" && item.checked === true || ids.has(String(item[idKey])))
            .map(item => provider === "quark" || provider === "uc" ? { ...item, stoken: item.stoken || token } : item);
          if (result.length) return result;
          empty = result;
        }
      }
      return empty;
    }
    let selected = [];
    switch (provider) {
      case "baidu": {
        selected = list(node(".wp-s-core-pan")?.__vue__?.selectedList);
        if (!available) selected = list(node(".file-list")?.__vue__?.allFileList).filter(item => item.selected);
        if (!available) { try { selected = list(view.require?.("system-core:context/context.js")?.instanceForSystem?.list?.getSelected?.()); } catch { /* Try the page bridge. */ } }
        if (!available && !share) {
          // Other views of my drive (categories such as the image timeline, search results…) use different components.
          // Look through the page's Vue 2 components, their parents and the Vuex state for a non-empty array whose
          // name mentions select/check and whose items are drive files (fs_id). Only a hit counts as recognised.
          const isFile = item => item && typeof item === "object" && ["number", "string"].includes(typeof item.fs_id);
          const pickArray = (owner, keys) => {
            for (const key of keys) {
              if (!/select|check/i.test(key)) continue;
              let value;
              try { value = owner[key] ?? owner.$data?.[key]; } catch { continue; }
              if (Array.isArray(value) && value.length && value.every(isFile)) return value;
            }
            return null;
          };
          const seen = new Set(), queue = [];
          const elements = doc.querySelectorAll?.("[class]") || [];
          for (let index = 0; index < elements.length && index < 6000 && queue.length < 600; index++) {
            const vm = elements[index].__vue__;
            if (vm && !seen.has(vm)) { seen.add(vm); queue.push(vm); }
          }
          for (let index = 0; index < queue.length && queue.length < 900; index++) {
            const parent = queue[index].$parent;
            if (parent && !seen.has(parent)) { seen.add(parent); queue.push(parent); }
          }
          let found = null;
          for (const vm of queue) {
            found = pickArray(vm, [...Object.keys(vm.$data || {}), ...Object.keys(vm._computedWatchers || {}), ...Object.keys(vm.$props || {})]);
            if (found) break;
          }
          const store = queue.find(vm => vm.$store)?.$store;
          const walk = (value, depth) => {
            if (found || !value || typeof value !== "object" || depth > 3) return;
            found = pickArray(value, Object.keys(value));
            if (!found) for (const key of Object.keys(value)) { if (value[key] && typeof value[key] === "object" && !Array.isArray(value[key])) walk(value[key], depth + 1); }
          };
          if (!found && store) { walk(store.state, 0); if (!found) found = pickArray(store.getters || {}, Object.keys(store.getters || {})); }
          if (found) selected = list(found);
        }
        if ((!available || !selected.length) && share) {
          // New share page (disk-share-v2, Vue 3, since 2026-11): checkboxes live on the list rows and file
          // metadata in locals.file_list (kept in sync when entering sub-folders); a single-file share has no rows.
          const locals = view.locals;
          const raw = locals?.dump?.()?.file_list;
          const files = Array.isArray(raw?.value) ? raw.value : Array.isArray(raw) ? raw : locals?.get?.("file_list");
          const rows = nodes(".JS-list-view-item[data-file-key]").filter(row => row.getAttribute?.("data-file-key") || row.dataset?.fileKey);
          const known = Array.isArray(files) ? files : [];
          if (rows.length) {
            available = true;
            selected = rows.filter(row => row.querySelector?.(".wp-checkbox--checked, [aria-checked='true']")).map(row => {
              const key = String(row.getAttribute?.("data-file-key") || row.dataset?.fileKey);
              const file = known.find(item => String(item.fs_id) === key);
              if (file) return file;
              const link = row.querySelector?.(".filename");
              const size = row.querySelector?.(".file-size")?.textContent?.trim() || "";
              return { fs_id: key, server_filename: link?.title || link?.textContent?.trim() || key, size: 0, isdir: /个(?:文件|项目)/.test(size) ? 1 : 0 };
            });
          } else if (/single/.test(String(view.SHAREPAGETYPE || locals?.dump?.()?.share_page_type?.value || "")) && known.length) selected = list(known);
        }
        break;
      }
      case "aliyun": selected = reactList(['[class^="node-list-table-view--"], [class*="node-list-table-view--"], [class*="node-list-grid-view--"]'], ["dataSource"], "fileId", ["selectedKeys"]); break;
      case "mcloud": {
        const own = node(".main_file_list")?.__vue__?.selectList;
        if (own) selected = list(own).map(value => value.item);
        else {
          const home = node(".home-page")?.__vue__;
          selected = list(home?._computedWatchers?.fileList?.value).filter((_, index) => home.selectedFile?.includes(index));
        }
        break;
      }
      case "tcloud": {
        selected = list(node(".c-file-list")?.__vue__?.selectedList);
        if (!available && node(".info-detail")?.__vue__?.fileDetail) selected = list([node(".info-detail").__vue__.fileDetail]);
        break;
      }
      case "xunlei": {
        const rows = nodes('[class*="SourceListItem__item--"]').map(element => element.__vue__).filter(Boolean);
        if (rows.length) selected = list(rows.filter(vue => vue.selected?.includes?.(vue.info?.id)).map(vue => vue.info));
        break;
      }
      case "guangya": selected = reactList(['.swangpan-file-list__root[data-ui="file-list"]'], ["dataSource"], "fileId", ["selectedItems"]); break;
      case "quark": case "uc": selected = reactList([".file-list", ".ant-table-wrapper"], ["list", "dataSource"], "fid", ["selectedRowKeys"]); break;
      case "123pan": selected = reactList(['.ant-table-wrapper, .tiled-list, .file-list, .single-file-sharing-container-content, .custom-table-wrapper, [class^="mfy_h-table-module__shell__"]'], ["dataSource", "loadedFileList", "files"], "FileId", []); break;
    }
    const primitive = value => typeof value === "string" && value.length <= 8192 || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value);
    const pick = (item, names) => Object.fromEntries(names.filter(key => primitive(item?.[key])).map(key => [key, item[key]]));
    // 勾选数量不设上限：发送时按设置的每批文件数（batchLimit）自动分批。
    const result = { available, files: selected.map(item => pick(item, fields.split(" "))) };
    if (share && provider === "baidu") {
      // Old share pages keep these in locals.dump() or yunData; disk-share-v2 also exposes locals.get(), may carry
      // sign/timestamp itself, and keeps the verified extraction key in the BDCLND cookie.
      const locals = view.locals?.dump?.() || {};
      const value = key => {
        let found = locals[key]?.value ?? locals[key];
        if (found == null || found === "") { try { found = view.locals?.get?.(key); } catch { /* Not available. */ } }
        return found ?? view.yunData?.[key] ?? "";
      };
      const cookie = name => {
        const raw = String(doc.cookie || "").split(";").map(part => part.trim()).find(part => part.startsWith(name + "="))?.slice(name.length + 1) || "";
        try { return decodeURIComponent(raw); } catch { return raw; }
      };
      result.shareData = pick({ uk: value("share_uk"), id: value("shareid"), bdstoken: value("bdstoken"), jsToken: view.jsToken || value("jsToken"),
        sekey: view.currentSekey || value("currentSekey") || value("sekey") || cookie("BDCLND") || view.cache?.list?.config?.params?.sekey || "",
        sign: value("sign"), timestamp: value("timestamp") }, ["uk", "id", "bdstoken", "jsToken", "sekey", "sign", "timestamp"]);
    }
    return result;
  }

  async function cloudSelected(context) {
    const fields = CLOUD_LAYOUTS[context.provider]?.[3];
    if (!fields || cloudOf()?.provider !== context.provider || new URL(context.url).origin !== location.origin) throw new Error("请返回原网盘页面，再重新获取文件");
    let snapshot;
    try { snapshot = cloudReadSelection(page, context.provider, fields, context.share); } catch { /* Isolated wrappers may deny page state. */ }
    if (snapshot?.available && (!context.share || context.provider !== "baidu" || snapshot.shareData?.id)) return snapshot;
    // @inject-into content hides React/Vue expandos. A one-shot page script reads just file metadata;
    // its DOM attribute is shared across realms. No persistent listener, GM capability or Tessera key is exposed.
    let script;
    try {
      const code = `(() => { const node = document.currentScript; try { node.setAttribute("data-tessera-selection", JSON.stringify((${cloudReadSelection.toString()})(window, ${JSON.stringify(context.provider)}, ${JSON.stringify(fields)}, ${JSON.stringify(context.share)}))); } catch { node.setAttribute("data-tessera-selection", "{}"); } })();`;
      script = await gm.pageScript(code);
      const text = script?.getAttribute("data-tessera-selection");
      if (!text || text.length > 256 * 1024 * 1024) throw new Error();
      snapshot = JSON.parse(text);
      if (typeof snapshot.available !== "boolean" || !Array.isArray(snapshot.files)) throw new Error();
    } catch { throw new Error("脚本无法读取网盘页面的勾选状态，请更新脚本并刷新页面；若仍失败，请检查脚本管理器的页面脚本权限"); }
    finally { script?.remove(); }
    if (context.url !== location.href) throw new Error("网盘页面已切换，请重新勾选文件再试");
    if (!snapshot.available) throw new Error("暂未识别到网盘文件列表，请等待列表加载后重试；若仍失败，请反馈当前页面地址和视图");
    return snapshot;
  }

  function cloudShareGuide(context) {
    if (!context.share || !["aliyun", "mcloud", "xunlei"].includes(context.provider)) return null;
    const path = { aliyun: "/drive/file/all", mcloud: "/w/#/main", xunlei: "/" }[context.provider];
    return { url: new URL(path, context.url).href,
      hint: "此网盘的分享页暂不支持直接取链。请先将文件保存到自己的网盘，再打开「我的网盘」勾选文件；转存成功后留在分享页仍无法发送。" };
  }

  /**
   * Snapshot only file fields, never React/Vue instances or account credentials.
   * Selected folders are listed through the drive's own list API (cloudListFolder) and shown as a tree (openCloudTree):
   * everything is checked by default, and each chosen file keeps its path relative to the selection so the server
   * rebuilds the same folders. LinkSwift itself only expands Baidu's own drive, and flattens it.
   */
  async function cloudSources(context) {
    if (cloudShareGuide(context)) throw new Error("请先将分享文件保存到自己的网盘，再打开「我的网盘」勾选文件；转存后请离开当前分享页");
    const [idKey, nameKey, sizeKey, fields] = CLOUD_LAYOUTS[context.provider];
    const snapshot = await cloudSelected(context);
    if (context.url !== location.href) throw new Error("网盘页面已切换，请重新勾选文件再试");
    let selectedFiles = snapshot.files;
    const isFile = item => item && item[idKey] != null && !item.isdir && !item.isFolder && !item.dirEtag && !item.caName
      && item.type !== "folder" && item.kind !== "drive#folder" && item.resType != 2 && item.file !== false && (item.Type == null || item.Type === 0)
      && (!["quark", "uc"].includes(context.provider) || item.file === true)
      && (context.provider !== "aliyun" || item.type === "file") && (context.provider !== "xunlei" || item.kind === "drive#file");
    const folders = selectedFiles.filter(item => item && cloudIsFolder(context.provider, item));
    // 同一次选择共用的会话（取链令牌等）：列出文件夹时取得的令牌，取链时继续使用。
    const session = new Map();
    if (folders.length) {
      if (!cloudFolderLister(context)) throw new Error(`${context.label}${context.share ? "的分享页" : ""}暂不支持直接选择文件夹，请打开文件夹后勾选里面的文件`);
      const picked = await cloudTreePicker({ ...context, session }, folders, selectedFiles.filter(isFile), snapshot.shareData);
      if (!picked) throw Object.assign(new Error("已取消"), { silent: true });
      if (context.url !== location.href) throw new Error("网盘页面已切换，请重新勾选文件再试");
      selectedFiles = picked;
    }
    const files = selectedFiles.filter(isFile);
    if (!files.length) throw new Error(folders.length ? "没有选择要发送的文件" : "请先在网盘中勾选文件或文件夹");
    const unique = new Map();
    for (const item of files) {
      const file = Object.fromEntries(fields.split(" ").filter(key => ["string", "number", "boolean"].includes(typeof item[key]) && String(item[key]).length <= 8192).map(key => [key, item[key]]));
      const source = new URL(context.url);
      source.search = "";
      if (!context.share) source.pathname = "/";
      source.hash = `tessera-${context.provider}-${encodeURIComponent(String(item[idKey]))}`;
      const shareData = context.provider === "baidu" && snapshot.shareData ? Object.fromEntries(["uk", "id", "bdstoken", "jsToken", "sekey", "sign", "timestamp"]
        .filter(key => ["string", "number"].includes(typeof snapshot.shareData[key]) && String(snapshot.shareData[key]).length <= 8192).map(key => [key, snapshot.shareData[key]])) : undefined;
      // 在网盘里勾选是明确的选择：之前发送过的也一起进入确认页（标「已发送过」，可移除），不再静默跳过或拦下。
      unique.set(source.href, { url: source.href, name: String(file[nameKey] || file.filename || ""), size: Number(file[sizeKey]) || null,
        cloud: { ...context, file, shareData, session }, resent: isSent(source.href), folder: typeof item.__folder === "string" ? item.__folder : "" });
    }
    return [...unique.values()];
  }

  /** The provider's own explanation (like LinkSwift's 服务器说), trimmed to one short line without control characters. */
  function cloudSays(message) {
    const text = typeof message === "string" ? message.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 160) : "";
    return text ? `，服务器说：${text}` : "";
  }
  function cloudFailure(context, code, message) {
    const safeCode = /^[\w.-]{1,48}$/.test(String(code)) ? `（代码 ${code}）` : "";
    return new Error(`${context.label}未返回有效下载地址${safeCode}${cloudSays(message)}。请确认已登录、文件可下载，再刷新网盘页面重试`);
  }
  const cloudSleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  function cloudOnce(context, key, factory) {
    if (!context.session.has(key)) context.session.set(key, Promise.resolve().then(factory).catch(error => { context.session.delete(key); throw error; }));
    return context.session.get(key);
  }
  /** All source requests are separate from api(): no Tessera access key, no custom User-Agent. */
  async function cloudRequest(context, input, { body, headers = {}, raw = false, withResponse = false } = {}) {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password || !CLOUD_API_HOSTS[context.provider]?.includes(url.hostname)) throw new Error("网盘接口地址无效");
    // Like LinkSwift's standHeaders: Origin and Referer name the drive's site; client identity comes from CLOUD_API_HEADERS.
    const origin = new URL(context.url).origin;
    const requestHeaders = { Accept: raw ? "text/html,*/*" : "application/json, text/plain, */*", Origin: origin, Referer: origin + "/", ...headers };
    if (Object.keys(requestHeaders).some(name => /^(?:proxy-authorization|host)$/i.test(name))) throw new Error("网盘请求头无效");
    const form = body instanceof URLSearchParams;
    if (body != null) requestHeaders["Content-Type"] = form ? "application/x-www-form-urlencoded" : "application/json;charset=UTF-8";
    const response = await gmRequest({ method: body == null ? "GET" : "POST", url: url.href, headers: requestHeaders, withCredentials: true,
      data: body == null ? undefined : form ? body.toString() : JSON.stringify(body), responseType: "text", timeout: 30000,
      errorMessage: "无法连接网盘接口，请检查网络和脚本的网站访问权限", timeoutMessage: "网盘取链超时，请稍后重试",
      sizeMessage: "网盘接口返回的数据过大，请刷新网盘页面后重试" }, undefined, 2 * 1024 * 1024);
    if (isChallenge(response.status, response.responseHeaders, response.responseText || "")) throw challengeError();
    if (raw) {
      if (response.status < 200 || response.status >= 300) throw cloudFailure(context, `HTTP-${response.status}`);
      return response;
    }
    // Error statuses usually still carry the provider's JSON code and message (e.g. Quark answers 400 with code 23018);
    // hand it to the adapter instead of reporting a bare HTTP status.
    let data;
    try { data = JSON.parse(response.responseText); } catch {
      if (response.status < 200 || response.status >= 300) throw cloudFailure(context, `HTTP-${response.status}`);
      throw new Error("网盘返回了登录、验证页面或无效数据，请在网盘网页中完成验证后重试");
    }
    if (data === null || typeof data !== "object") throw cloudFailure(context, `HTTP-${response.status}`);
    return withResponse ? { data, headers: response.responseHeaders || "" } : data;
  }
  function cloudDownload(context, input, headers = {}) {
    let url;
    try { url = new URL(input); } catch { throw cloudFailure(context); }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw cloudFailure(context);
    const carriesCookie = Object.entries(headers).some(([key, value]) => key.toLowerCase() === "cookie" && value);
    const cookieHosts = { baidu: /(?:^|\.)(?:baidu\.com|baidupcs\.(?:com|cn|net))$/, quark: /(?:^|\.)quark\.cn$/, uc: /(?:^|\.)uc\.cn$/ };
    if (carriesCookie && !cookieHosts[context.provider]?.test(url.hostname)) throw new Error("网盘返回的下载域名无法验证，未转交登录 Cookie");
    return { url: url.href, headers };
  }

  /** Small local MD5 for provider request signatures (RFC 1321); no runtime CDN dependency. */
  function cloudMd5(input) {
    const bytes = new TextEncoder().encode(String(input));
    const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
    padded.set(bytes); padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, bytes.length * 8, true);
    view.setUint32(padded.length - 4, Math.floor(bytes.length / 0x20000000), true);
    const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    let state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
    for (let offset = 0; offset < padded.length; offset += 64) {
      let [a, b, c, d] = state;
      for (let i = 0; i < 64; i++) {
        const round = i >>> 4;
        const f = round === 0 ? b & c | ~b & d : round === 1 ? d & b | ~d & c : round === 2 ? b ^ c ^ d : c ^ (b | ~d);
        const g = round === 0 ? i : round === 1 ? (5 * i + 1) % 16 : round === 2 ? (3 * i + 5) % 16 : 7 * i % 16;
        const sum = (a + f + Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) + view.getUint32(offset + g * 4, true)) | 0;
        const shift = shifts[round * 4 + i % 4];
        [a, b, c, d] = [d, b + (sum << shift | sum >>> (32 - shift)) | 0, b, c];
      }
      state = state.map((value, index) => value + [a, b, c, d][index] | 0);
    }
    return state.map(value => [0, 8, 16, 24].map(shift => (value >>> shift & 255).toString(16).padStart(2, "0")).join("")).join("");
  }

  function authorizeCloudBaidu() {
    const state = [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, "0")).join("");
    gm.set("cloud-baidu-auth", { state, expires: Date.now() + 10 * 60 * 1000 });
    const url = new URL(BAIDU_AUTHORIZE); url.searchParams.set("state", state);
    gm.openTab(url.href);
  }
  function captureCloudAuthorization() {
    if (location.origin !== "https://openapi.baidu.com" || location.pathname !== "/oauth/2.0/login_success") return false;
    const params = new URLSearchParams(location.hash.slice(1));
    const pending = gm.get("cloud-baidu-auth");
    const token = params.get("access_token");
    if (!pending || pending.expires < Date.now() || params.get("state") !== pending.state || !token || token.length > 4096 || /[\s\x00-\x1f]/.test(token)) return false;
    const seconds = Math.min(Math.max(Number(params.get("expires_in")) || 3600, 1), 365 * 86400);
    gm.set("cloud-baidu-token", { token, expires: Date.now() + seconds * 1000 });
    gm.set("cloud-baidu-auth", null);
    try { (page.history || history).replaceState(null, "", location.pathname + location.search); } catch { /* 来源页面仍可关闭 */ }
    return true;
  }

  // $baidu.getFilesUrl / getShareData / getShareFilesUrl. OAuth consent stays in the provider's own tab.
  const baiduToken = () => { const cached = gm.get("cloud-baidu-token"); return cached?.expires > Date.now() + 60000 ? cached.token : ""; };
  function baiduError(context, response) {
    if ([9019, 110, 111].includes(response.errno)) {
      gm.set("cloud-baidu-token", null);
      return new Error("百度取链授权已过期，请返回面板点击「授权百度取链」后重试");
    }
    if (response.errno === 112) return new Error("百度网盘页面已过期，请刷新网盘页面后重试");
    return cloudFailure(context, response.errno, response.errmsg || response.show_msg);
  }
  function baiduResult(context, dlink, token) {
    const result = cloudDownload(context, dlink, { "User-Agent": CLOUD_DOWNLOAD_UA.baidu });
    if (token) {
      const url = new URL(result.url);
      if (!/(?:^|\.)(?:baidu\.com|baidupcs\.(?:com|cn|net))$/.test(url.hostname)) throw cloudFailure(context);
      url.searchParams.set("access_token", token); result.url = url.href;
    }
    return result;
  }
  /** My drive: up to 50 fsids per filemetas request, sent as pan.baidu.com like LinkSwift. */
  async function cloudBaiduMany(contexts) {
    const context = contexts[0], token = baiduToken();
    if (!token) throw new Error("请返回面板点击「授权百度取链」，在百度页面确认后回来重试");
    const url = new URL("https://pan.baidu.com/rest/2.0/xpan/multimedia?method=filemetas&dlink=1");
    url.searchParams.set("fsids", JSON.stringify(contexts.map(item => item.file.fs_id))); url.searchParams.set("access_token", token);
    const response = await cloudRequest(context, url, { headers: CLOUD_API_HEADERS.baidu });
    if (response.errno !== 0 || !Array.isArray(response.list)) throw baiduError(context, response);
    return contexts.map(item => {
      const file = response.list.find(entry => String(entry.fs_id) === String(item.file.fs_id));
      try { return file?.dlink ? baiduResult(item, file.dlink, token) : cloudFailure(item); } catch (error) { return error; }
    });
  }
  async function cloudBaidu(context) {
    if (!context.share) {
      const [result] = await cloudBaiduMany([context]);
      if (result instanceof Error) throw result;
      return result;
    }
    const shared = await cloudOnce(context, "baidu-share", async () => {
      const data = context.shareData || {};
      if (!data.uk || !data.id) throw new Error("请先打开分享文件列表并完成提取码验证，再获取文件");
      // The new share page already provides a signature; only ask tplconfig when it is missing.
      if (data.sign && data.timestamp) return data;
      const url = new URL("https://pan.baidu.com/share/tplconfig?fields=sign,timestamp&channel=chunlei&web=1&app_id=250528&clienttype=0&view_mode=1");
      url.searchParams.set("surl", new URL(context.url).pathname.split("/").pop());
      url.searchParams.set("bdstoken", data.bdstoken || "");
      const sign = await cloudRequest(context, url);
      if (!sign.data?.sign || !sign.data?.timestamp) throw baiduError(context, sign);
      return { ...data, ...sign.data };
    });
    const url = new URL("https://pan.baidu.com/api/sharedownload?channel=chunlei&clienttype=0&web=1&app_id=250528");
    for (const key of ["sign", "timestamp", "bdstoken", "jsToken"]) if (shared[key]) url.searchParams.set(key, shared[key]);
    if (cloudCookie("BAIDUID")) url.searchParams.set("logid", btoa(cloudCookie("BAIDUID")));
    const body = new URLSearchParams({ encrypt: "0", product: "share", uk: shared.uk, primaryid: shared.id, fid_list: JSON.stringify([context.file.fs_id]) });
    if (shared.sekey) body.set("extra", JSON.stringify({ sekey: shared.sekey }));
    const response = await cloudRequest(context, url, { body });
    if (response.errno === 0 && typeof response.list === "string") throw new Error("此文件大小超过分享页可获取的限制，请保存到自己的网盘后在网盘中发送");
    const file = Array.isArray(response.list) && response.list.find(item => String(item.fs_id) === String(context.file.fs_id));
    if (response.errno !== 0 || !file?.dlink) throw baiduError(context, response);
    return baiduResult(context, file.dlink, baiduToken());
  }

  // ---------- 网盘文件夹：列出内容，按树形结构挑选 ----------
  // 每个网盘用自己的列表接口（与取链同一套凭据与客户端身份），一层一层地读；读到的条目只保留 CLOUD_LAYOUTS 里的字段。
  const CLOUD_TREE_PAGE = 200;     // 树里每次渲染的行数，文件夹内容很多时点「再显示」继续，避免一次创建几万个节点
  function cloudIsFolder(provider, item) {
    switch (provider) {
      case "baidu": return Boolean(Number(item.isdir));
      case "quark": case "uc": return item.file === false;
      case "aliyun": return item.type === "folder";
      case "123pan": return item.Type === 1;
      case "tcloud": return item.isFolder === true;
      case "xunlei": return item.kind === "drive#folder";
      case "mcloud": return Boolean(item.dirEtag || item.caName);
      case "guangya": return item.resType == 2;
      default: return false;
    }
  }
  /** 能列出文件夹内容的网盘：百度（自己的网盘与分享）、夸克／UC（自己的网盘与分享）、阿里、123、天翼与迅雷自己的网盘。 */
  function cloudFolderLister(context) {
    const own = { baidu: cloudListBaidu, quark: cloudListQuarkUc, uc: cloudListQuarkUc, aliyun: cloudListAliyun, "123pan": cloudList123, tcloud: cloudListTelecom, xunlei: cloudListXunlei };
    const shared = { baidu: cloudListBaidu, quark: cloudListQuarkUc, uc: cloudListQuarkUc };
    return (context.share ? shared : own)[context.provider] || null;
  }
  const cloudKeep = (provider, item) => Object.fromEntries(CLOUD_LAYOUTS[provider][3].split(" ")
    .filter(key => ["string", "number", "boolean"].includes(typeof item?.[key]) && String(item[key]).length <= 8192).map(key => [key, item[key]]));

  /** 百度：自己的网盘用开放平台 list（需授权，与取链相同），分享页用 share/list（带提取码验证后的 sekey）。 */
  async function cloudListBaidu(context, folder, page, share) {
    if (typeof folder.path !== "string" || !folder.path.startsWith("/")) throw new Error("无法读取所选文件夹的位置，请打开文件夹后勾选里面的文件");
    let url;
    if (context.share) {
      if (!share?.uk || !share?.id) throw new Error("请在分享网页完成提取码验证，打开文件列表后重试");
      url = new URL("https://pan.baidu.com/share/list?web=1&app_id=250528&channel=chunlei&clienttype=0&showempty=0&order=name&desc=0&num=100");
      url.searchParams.set("uk", share.uk); url.searchParams.set("shareid", share.id);
      url.searchParams.set("dir", folder.path); url.searchParams.set("page", String(page));
      if (share.sekey) url.searchParams.set("sekey", share.sekey);
    } else {
      const token = baiduToken();
      if (!token) throw new Error("读取文件夹需要先授权：请返回面板点击「授权百度取链」，在百度页面确认后回来重试");
      url = new URL("https://pan.baidu.com/rest/2.0/xpan/file?method=list&showempty=1&order=name&limit=1000");
      url.searchParams.set("dir", folder.path); url.searchParams.set("access_token", token);
      url.searchParams.set("start", String((page - 1) * 1000));
    }
    const response = await cloudRequest(context, url, { headers: context.share ? {} : CLOUD_API_HEADERS.baidu });
    if (response.errno !== 0 && response.errmsg !== "succ") throw baiduError(context, response);
    const list = Array.isArray(response.list) ? response.list : [];
    return { items: list.map(item => ({ fs_id: item.fs_id, server_filename: item.server_filename, size: item.size, isdir: Number(item.isdir) ? 1 : 0, path: item.path })),
      more: list.length >= (context.share ? 100 : 1000) };
  }
  /** 夸克／UC：自己的网盘 file/sort，分享页 sharepage/detail（条目自带 share_fid_token，沿用页面的 stoken）。 */
  async function cloudListQuarkUc(context, folder, page) {
    const quark = context.provider === "quark", identity = CLOUD_API_HEADERS[context.provider];
    const cookie = await cookieHeader(context.url);
    const base = quark ? "https://drive-pc.quark.cn/1/clouddrive" : "https://pc-api.uc.cn/1/clouddrive";
    const url = new URL(base + (context.share ? "/share/sharepage/detail" : "/file/sort"));
    for (const [key, value] of Object.entries({ pr: quark ? "ucpro" : "UCBrowser", fr: "pc", pdir_fid: folder.fid, _page: page, _size: 100, _fetch_total: 1, _sort: "file_type:asc,file_name:asc" }))
      url.searchParams.set(key, String(value));
    if (context.share) {
      const pwdId = page_pwdId(context);
      if (!pwdId || !folder.stoken) throw new Error("请在分享网页完成提取码验证，打开文件列表后重试");
      url.searchParams.set("pwd_id", pwdId); url.searchParams.set("stoken", folder.stoken);
      url.searchParams.set("force", "0"); url.searchParams.set("_fetch_share", "0");
    }
    const response = await cloudRequest(context, url, { headers: { ...identity, ...(cookie ? { Cookie: cookie } : {}) } });
    if (response.code !== 0 || !Array.isArray(response.data?.list)) throw quarkError([{ ...context, file: folder }], response);
    const total = Number(response.metadata?._total) || 0;
    return { items: response.data.list.map(item => ({ ...item, ...(context.share ? { stoken: folder.stoken } : {}) })), more: page * 100 < total };
  }
  function page_pwdId(context) {
    return page.factStat?.ut?.baseParams?.pwd_id || page.factStat?.wa?.customStatParams?.pwd_id
      || new URL(context.url).pathname.match(/^\/(?:s|share)\/([^/?#]+)/)?.[1] || "";
  }
  /** 阿里云盘：adrive/v3/file/list，按 next_marker 翻页。 */
  async function cloudListAliyun(context, folder, page, _share, state) {
    const token = cloudStorage("token");
    if (!token?.access_token || !token?.token_type) throw new Error("请先登录阿里云盘，再刷新页面重试");
    const domain = new URL(context.url).hostname.endsWith("alipan.com") ? "api.alipan.com" : "api.aliyundrive.com";
    const response = await cloudRequest(context, `https://${domain}/adrive/v3/file/list`, {
      body: { drive_id: folder.driveId, parent_file_id: folder.fileId, limit: 200, marker: page > 1 ? state.marker || "" : "", order_by: "name", order_direction: "ASC", all: false, fields: "*" },
      headers: { Authorization: `${token.token_type} ${token.access_token}`, "X-Canary": "client=windows,app=adrive,version=v6.0.0" },
    });
    if (response.code === "AccessTokenInvalid") throw new Error("阿里云盘访问令牌已过期，请刷新网盘页面后重试");
    if (!Array.isArray(response.items)) throw cloudFailure(context, response.code, response.message);
    state.marker = response.next_marker || "";
    return { items: response.items.map(item => ({ fileId: item.file_id, driveId: item.drive_id, name: item.name, size: item.size, type: item.type })), more: Boolean(state.marker) };
  }
  /** 123 云盘：file/list/new，按页读取。 */
  async function cloudList123(context, folder, page) {
    const token = cloudStorage("authorToken");
    if (!token) throw new Error("请先登录 123 云盘，再刷新页面重试");
    const url = new URL("https://api.123pan.cn/api/file/list/new?driveId=0&limit=100&next=0&orderBy=file_name&orderDirection=asc&trashed=false&SearchData=&OnlyLookAbnormalFile=0&event=homeListFile&operateType=4&inDirectSpace=false");
    url.searchParams.set("parentFileId", String(folder.FileId)); url.searchParams.set("Page", String(page));
    const response = await cloudRequest(context, url, { headers: { ...CLOUD_API_HEADERS["123pan"], Authorization: `Bearer ${token}`, Platform: "web",
      "App-Version": "323", LoginUuid: cloudStorage("LoginUuid") || "" } });
    if (response.code == 5112) throw new Error("请先登录 123 云盘，再刷新页面重试");
    if (response.code !== 0 || !Array.isArray(response.data?.InfoList)) throw cloudFailure(context, response.code, response.message);
    return { items: response.data.InfoList, more: response.data.Next != null && String(response.data.Next) !== "-1" };
  }
  /** 天翼云盘：open/file/listFiles.action，签名规则与取链相同（参数按名称排序后取 MD5）。 */
  async function cloudListTelecom(context, folder, page) {
    const token = await cloudOnce(context, "tcloud-token", async () => {
      const response = await cloudRequest(context, "https://api.cloud.189.cn/open/oauth2/ssoH5.action", { raw: true });
      const value = new URL(response.finalUrl || "https://api.cloud.189.cn").searchParams.get("accessToken");
      if (!value) throw new Error("请先登录天翼云盘，再刷新页面重试");
      return value;
    });
    const time = Date.now();
    const params = { folderId: String(folder.fileId), pageNum: String(page), pageSize: "100", mediaType: "0", iconOption: "0", orderBy: "filename", descending: "false" };
    const sign = Object.entries({ AccessToken: token, Timestamp: String(time), ...params }).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join("&");
    const url = new URL("https://api.cloud.189.cn/open/file/listFiles.action");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await cloudRequest(context, url, { headers: { "Sign-Type": "1", Accesstoken: token, Timestamp: String(time), Signature: cloudMd5(sign) } });
    if (response.errorcode === "InvalidSessionKey") { context.session.delete("tcloud-token"); throw new Error("请先登录天翼云盘，再刷新页面重试"); }
    const list = response.fileListAO;
    if (response.res_code != 0 || !list) throw cloudFailure(context, response.res_code || response.errorcode, response.res_message || response.errorMsg);
    const items = [...(list.folderList || []).map(item => ({ fileId: String(item.id), fileName: item.name, size: 0, isFolder: true })),
      ...(list.fileList || []).map(item => ({ fileId: String(item.id), fileName: item.name, size: item.size, isFolder: false }))];
    return { items, more: page * 100 < (Number(list.count) || 0) };
  }
  /** 迅雷云盘：drive/v1/files，按 next_page_token 翻页（凭据与取链相同）。 */
  async function cloudListXunlei(context, folder, page, _share, state) {
    let headers = await cloudOnce(context, "xunlei-token", () => cloudXunleiToken(context));
    const url = new URL("https://api-pan.xunlei.com/drive/v1/files?limit=100&with_audit=true");
    url.searchParams.set("parent_id", String(folder.id));
    url.searchParams.set("filters", JSON.stringify({ phase: { eq: "PHASE_TYPE_COMPLETE" }, trashed: { eq: false } }));
    if (page > 1 && state.token) url.searchParams.set("page_token", state.token);
    let response = await cloudRequest(context, url, { headers });
    if (response.error_code == 9) {
      headers = await cloudOnce(context, "xunlei-refresh", () => cloudXunleiToken(context, true));
      response = await cloudRequest(context, url, { headers });
    }
    if (!Array.isArray(response.files)) throw cloudFailure(context, response.error_code, response.error_description);
    state.token = response.next_page_token || "";
    return { items: response.files, more: Boolean(state.token) };
  }

  // 测试替换为不经界面的挑选（见 tests/test_grabber.cjs）。
  let cloudTreePicker = (...args) => openCloudTree(...args);
  /** 网盘里的名称作为 Tessera 的文件夹名：去掉斜杠与控制字符，避开 . / .. 与系统目录。 */
  function cloudFolderSegment(name) {
    let value = String(name || "").replace(/[\x00-\x1f\x7f]/g, "").replace(/[\\/]/g, "_").trim();
    if (!value || value === "." || value === "..") value = "未命名文件夹";
    if (value.startsWith(".tgdrive")) value = "_" + value.slice(1);
    return value.slice(0, 120);
  }

  /**
   * 逐层列出所选文件夹（含子目录），建成树：文件夹 { dir, name, children, parent, total, checked, size, checkedSize, open }，
   * 文件 { name, size, item, parent, checked }，默认全部选中。数量不设上限。
   */
  async function cloudListTree(context, folders, looseFiles, shareData, onProgress = () => {}, cancelled = () => false) {
    const [, nameKey, sizeKey] = CLOUD_LAYOUTS[context.provider];
    const lister = cloudFolderLister(context);
    const tree = { files: 0, folders: 0 };
    // 根节点与所选的顶层文件夹默认展开，更深的子目录点开再看。
    const makeDir = (name, parent) => ({ dir: true, name: cloudFolderSegment(name), children: [], parent, total: 0, checked: 0, size: 0, checkedSize: 0, open: !parent || !parent.parent });
    const root = tree.root = makeDir("", null);
    const addFile = (dir, item) => {
      const size = Number(item[sizeKey]) || 0;
      dir.children.push({ name: String(item[nameKey] || ""), size, item: cloudKeep(context.provider, item), parent: dir, checked: true });
      for (let node = dir; node; node = node.parent) { node.total++; node.checked++; node.size += size; node.checkedSize += size; }
      tree.files++;
    };
    for (const item of looseFiles) addFile(root, item);
    const queue = folders.map(item => { const dir = makeDir(item[nameKey], root); root.children.push(dir); return { item: cloudKeep(context.provider, item), node: dir }; });
    let listed = 0;
    while (queue.length && !cancelled()) {
      const { item, node } = queue.shift();
      tree.folders++;
      const state = {};
      for (let pageNumber = 1; !cancelled(); pageNumber++) {
        // 百度分享页的列表需要页面上的 uk、shareid 与提取码验证后的 sekey（cloudSelected 已在快照里取得）。
        const result = await lister(context, item, pageNumber, shareData, state);
        if (cancelled()) return tree;
        for (const child of result.items) {
          if (cloudIsFolder(context.provider, child)) {
            const dir = makeDir(child[nameKey], node);
            node.children.push(dir);
            queue.push({ item: cloudKeep(context.provider, child), node: dir });
          } else addFile(node, child);
        }
        onProgress(tree);
        // 与 LinkSwift 相同的节奏：每 50 次列表请求停 3 秒，避免被网盘限流。
        if (++listed % 50 === 0) await cloudSleep(3000);
        if (!result.more) break;
      }
    }
    return tree;
  }
  /** 选中的文件条目，带 __folder：相对保存位置的子目录（以 / 结尾，所选文件夹本身的名称在最前）。 */
  function cloudPickedFiles(root) {
    const picked = [];
    const walk = (node, path) => {
      for (const child of node.children) {
        if (child.dir) { if (child.checked) walk(child, path + child.name + "/"); }
        else if (child.checked) picked.push({ ...child.item, __folder: path });
      }
    };
    walk(root, "");
    return picked;
  }

  /**
   * 读取所选文件夹（含子目录）并在面板内以树形结构挑选文件：默认全部选中，可全选／取消、按文件夹勾选。
   * 返回选中的文件条目（带 __folder），取消时返回 null。
   */
  function openCloudTree(context, folders, looseFiles, shareData) {
    return new Promise(resolve => {
      if (!panel) return resolve(null);
      panel.layer?.close();
      let cancelled = false, settled = false, root = null, fileCount = 0, folderCount = 0;
      const finish = value => { if (settled) return; settled = true; cancelled = true; closeLayer(); resolve(value); };
      const body = h("div", { className: "body tree-body" });
      const footer = h("footer", {});
      const layer = h("div", { className: "layer", role: "dialog", "aria-label": "选择要发送的文件" },
        h("header", {}, iconButton("back", "返回", () => finish(null), "back"), h("span", { className: "title" }, "选择要发送的文件")), body, footer);
      const host = panel;
      const closeLayer = () => {
        layer.remove();
        host.classList.remove("has-layer");
        if (panel && panel.layer === controller) panel.layer = null;
      };
      const controller = { close: () => finish(null) };
      panel.layer = controller;
      host.classList.add("has-layer");
      panel.append(layer);

      const loading = emptyState("loader", "", true);
      const progress = loading.lastChild;
      progress.setAttribute("role", "status");
      const showLoading = () => {
        progress.textContent = `正在读取文件夹内容… 已找到 ${fileCount} 个文件、${folderCount} 个文件夹`;
        body.replaceChildren(loading);
        footer.replaceChildren(h("span", { className: "spacer" }), h("button", { type: "button", className: "btn ghost", onclick: () => finish(null) }, "取消"));
      };
      showLoading();

      const progressed = tree => { fileCount = tree.files; folderCount = tree.folders; progress.textContent = `正在读取文件夹内容… 已找到 ${fileCount} 个文件、${folderCount} 个文件夹`; };
      void cloudListTree(context, folders, looseFiles, shareData, progressed, () => cancelled).then(tree => {
        if (cancelled) return;
        root = tree.root; progressed(tree);
        render();
      }, error => {
        if (cancelled) return;
        body.replaceChildren(h("div", { className: "error" }, error.message));
        footer.replaceChildren(h("span", { className: "spacer" }), h("button", { type: "button", className: "btn ghost", onclick: () => finish(null) }, "关闭"));
      });

      // ---------- 渲染：行节点按需创建，勾选时只更新受影响的复选框与统计 ----------
      const summary = h("span", { className: "tree-summary" });
      const allBox = h("input", { type: "checkbox", "aria-label": "全选" });
      const confirm = h("button", { type: "button", className: "btn primary" });
      const setBox = node => {
        if (!node.box) return;
        const all = node.dir ? node.total > 0 && node.checked === node.total : node.checked;
        const some = node.dir && node.checked > 0 && !all;
        node.box.checked = all; node.box.indeterminate = some;
        node.mark.className = `check${all ? " on" : some ? " on partial" : ""}`;
      };
      const refreshSummary = () => {
        summary.textContent = `已选 ${root.checked} / ${root.total} 个文件${root.checkedSize ? ` · ${formatSize(root.checkedSize)}` : ""}`;
        allBox.checked = root.total > 0 && root.checked === root.total;
        allBox.indeterminate = root.checked > 0 && root.checked < root.total;
        allMark.className = `check${allBox.checked ? " on" : allBox.indeterminate ? " on partial" : ""}`;
        const rounds = Math.ceil(root.checked / batchLimit());
        confirm.disabled = !root.checked;
        confirm.textContent = rounds > 1 ? `确定（${root.checked}，分 ${rounds} 批）` : `确定（${root.checked}）`;
      };
      const setChecked = (node, value) => {
        const apply = item => {
          if (item.dir) { item.children.forEach(apply); setBox(item); return; }
          if (item.checked === value) return;
          item.checked = value;
          for (let dir = item.parent; dir; dir = dir.parent) { dir.checked += value ? 1 : -1; dir.checkedSize += value ? item.size : -item.size; }
          setBox(item);
        };
        apply(node);
        for (let dir = node.parent; dir; dir = dir.parent) setBox(dir);
        refreshSummary();
      };
      const allMark = h("span", { className: "check" }, svg("check", 12, 3));
      // 分页渲染：先放前 CLOUD_TREE_PAGE 行，末尾的「再显示」按钮接着放下一段。
      const appendRows = (container, nodes, depth, start = 0) => {
        const end = Math.min(nodes.length, start + CLOUD_TREE_PAGE);
        container.append(...nodes.slice(start, end).map(child => rowFor(child, depth)));
        if (end < nodes.length) {
          const more = h("button", { type: "button", className: "tree-more", style: `--depth:${depth}`,
            onclick: () => { more.remove(); appendRows(container, nodes, depth, end); } }, `再显示 ${Math.min(CLOUD_TREE_PAGE, nodes.length - end)} 项（还有 ${nodes.length - end} 项）`);
          container.append(more);
        }
      };
      const rowFor = (node, depth) => {
        node.box = h("input", { type: "checkbox", "aria-label": `${node.dir ? "文件夹" : "文件"} ${node.name}`, onchange: () => setChecked(node, node.box.checked) });
        node.mark = h("span", { className: "check" }, svg("check", 12, 3));
        const pick = h("label", { className: "pick tree-pick" }, node.box, node.mark);
        const row = h("div", { className: `tree-row${node.dir ? " is-dir" : ""}`, style: `--depth:${depth}` });
        if (node.dir) {
          const children = h("div", { className: "tree-children", role: "group" });
          const toggle = h("button", { type: "button", className: "tree-toggle", "aria-expanded": String(node.open), "aria-label": `${node.open ? "收起" : "展开"} ${node.name}` }, svg("chevron", 14));
          const expand = open => {
            node.open = open;
            toggle.setAttribute("aria-expanded", String(open)); toggle.setAttribute("aria-label", `${open ? "收起" : "展开"} ${node.name}`);
            children.hidden = !open;
            if (open && !children.firstChild) appendRows(children, node.children, depth + 1);
          };
          toggle.onclick = () => expand(!node.open);
          row.append(toggle, pick, svg("folder", 16), h("span", { className: "tree-name", title: node.name, ondblclick: () => expand(!node.open) }, node.name),
            h("span", { className: "tree-meta" }, `${node.total} 个文件${node.size ? ` · ${formatSize(node.size)}` : ""}`));
          setBox(node);
          const wrap = h("div", { className: "tree-node" }, row, children);
          expand(node.open);
          return wrap;
        }
        row.append(h("span", { className: "tree-toggle-space" }), pick, svg("file", 16), h("span", { className: "tree-name", title: node.name }, node.name),
          h("span", { className: "tree-meta" }, node.size ? formatSize(node.size) : ""));
        setBox(node);
        return row;
      };
      function render() {
        allBox.onchange = () => setChecked(root, allBox.checked);
        const head = h("div", { className: "tree-head" }, h("label", { className: "pick tree-pick" }, allBox, allMark), h("span", { className: "tree-all" }, "全选"), h("span", { className: "spacer" }), summary);
        const parts = [head];
        if (!root.total) parts.push(h("p", { className: "hint" }, "所选文件夹里没有文件。"));
        const treeNode = h("div", { className: "tree", role: "tree" });
        appendRows(treeNode, root.children, 0);
        parts.push(treeNode);
        parts.push(h("p", { className: "hint" }, "保存时会在所选位置下按原来的文件夹结构建立子目录。"));
        body.replaceChildren(...parts);
        confirm.onclick = () => finish(cloudPickedFiles(root));
        footer.replaceChildren(h("span", { className: "spacer" }), h("button", { type: "button", className: "btn ghost", onclick: () => finish(null) }, "取消"), confirm);
        refreshSummary();
      }
    });
  }

  // $aliyun.getFilesUrl. Keep results associated with their own file; upstream's batch assignment is not reused.
  async function cloudAliyun(context) {
    const token = cloudStorage("token");
    if (!token?.access_token || !token?.token_type) throw new Error("请先登录阿里云盘，再刷新页面重试");
    const domain = new URL(context.url).hostname.endsWith("alipan.com") ? "api.alipan.com" : "api.aliyundrive.com";
    const response = await cloudRequest(context, `https://${domain}/v2/file/get_download_url`, {
      body: { drive_id: context.file.driveId, file_id: context.file.fileId },
      headers: { Authorization: `${token.token_type} ${token.access_token}`, "X-Canary": "client=windows,app=adrive,version=v6.0.0" },
    });
    if (response.code === "AccessTokenInvalid") throw new Error("阿里云盘访问令牌已过期，请刷新网盘页面后重试");
    if (!response.url || response.code) throw cloudFailure(context, response.code, response.message);
    return cloudDownload(context, response.url, { Referer: new URL(context.url).origin + "/" });
  }

  // $mcloud.getSign / getFileUrl. Initialize the nonce before appending characters (upstream leaves it undefined).
  async function cloudMobile(context) {
    const authorization = cloudCookie("authorization");
    if (!authorization) throw new Error("请先登录中国移动云盘，再刷新页面重试");
    const body = { fileId: context.file.contentID };
    const time = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
    const chars = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678";
    const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map(value => chars[value % chars.length]).join("");
    const sorted = encodeURIComponent(JSON.stringify(body).replace(/\s*/g, "")).split("").sort().join("");
    const sign = cloudMd5(cloudMd5(btoa(sorted)) + cloudMd5(time + ":" + nonce)).toUpperCase();
    const response = await cloudRequest(context, "https://personal-kd-njs.yun.139.com/hcy/file/getDownloadUrl", { body, headers: {
      Authorization: authorization, Caller: "web", "CMS-DEVICE": "default", "Mcloud-Channel": "1000101", "Mcloud-Client": "10701",
      "Mcloud-Sign": `${time},${nonce},${sign}`, "Mcloud-Version": "7.14.2", "X-DeviceInfo": "||9|7.17.0|edge||||windows 10||zh-CN|||",
      "X-Huawei-ChannelSrc": "10000034", "X-Inner-Ntwk": "2", "X-M4C-Caller": "PC", "X-M4C-Src": "10002", "X-SvcType": "1",
      "X-Yun-Api-Version": "v1", "X-Yun-App-Channel": "10000034", "X-Yun-Channel-Source": "10000034",
      "X-Yun-Client-Info": "||9|7.17.0|edge||||windows 10||zh-CN|||||", "X-Yun-Module-Type": "100", "X-Yun-Svc-Type": "1", "X-Yun-Url-Type": "3",
    } });
    if (!response.success || !response.data?.url) throw cloudFailure(context, response.code, response.message);
    return cloudDownload(context, response.data.url);
  }

  // $tcloud.getToken / getFileUrl. The SSO token is kept in this batch, not persisted by the script.
  async function cloudTelecom(context) {
    const token = await cloudOnce(context, "tcloud-token", async () => {
      const response = await cloudRequest(context, "https://api.cloud.189.cn/open/oauth2/ssoH5.action", { raw: true });
      const value = new URL(response.finalUrl || "https://api.cloud.189.cn").searchParams.get("accessToken");
      if (!value) throw new Error("请先登录天翼云盘，再刷新页面重试");
      return value;
    });
    const time = Date.now();
    const url = new URL("https://api.cloud.189.cn/open/file/getFileDownloadUrl.action");
    url.searchParams.set("fileId", context.file.fileId);
    let sign = `AccessToken=${token}&Timestamp=${time}`;
    if (context.file.shareId) { url.searchParams.set("dt", "1"); url.searchParams.set("shareId", context.file.shareId); sign += "&dt=1"; }
    sign += `&fileId=${context.file.fileId}`;
    if (context.file.shareId) sign += `&shareId=${context.file.shareId}`;
    const response = await cloudRequest(context, url, { headers: { "Sign-Type": "1", Accesstoken: token, Timestamp: String(time), Signature: cloudMd5(sign) } });
    if (response.errorcode === "InvalidSessionKey") { context.session.delete("tcloud-token"); throw new Error("请先登录天翼云盘，再刷新页面重试"); }
    if (response.res_code === "ShareNotFoundFlatDir") throw new Error("请先转存文件，再到「我的网盘」中勾选发送");
    if (response.res_code != 0 || !response.fileDownloadUrl) throw cloudFailure(context, response.res_code || response.errorcode, response.res_message || response.errorMsg);
    return cloudDownload(context, response.fileDownloadUrl);
  }

  function cloudCredentials() {
    let credentials = null, captcha = null, credentialsKey = "", clientId = "";
    try {
      const storage = page.localStorage || localStorage;
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key.startsWith("credentials_") && cloudStorage(key)?.access_token) {
          credentials = cloudStorage(key); credentialsKey = key; clientId = key.slice("credentials_".length); break;
        }
      }
      captcha = cloudStorage(`captcha_${clientId}`);
    } catch { /* 缺少凭据时由调用方提示登录 */ }
    const rawDeviceId = cloudStorage("deviceid");
    return { credentials, captcha, credentialsKey, clientId, rawDeviceId, deviceId: String(rawDeviceId || "").match(/\w{32}/)?.[0] || "" };
  }

  // $xunlei.getToken / _getCaptchaSign / getFileUrl. Refresh only against the provider's own endpoints.
  async function cloudXunleiToken(context, force = false) {
    const token = cloudCredentials();
    let { credentials, captcha } = token;
    if (!token.clientId || !token.deviceId || !credentials?.access_token) throw new Error("请先登录迅雷云盘，再刷新页面重试");
    const expired = value => value && Date.parse(value) <= Date.now() + 60000;
    if (force || expired(credentials.expires_at)) {
      if (!credentials.refresh_token) throw new Error("迅雷登录已过期，请在网盘网页重新登录");
      const response = await cloudRequest(context, "https://xluser-ssl.xunlei.com/v1/auth/token", {
        body: { client_id: token.clientId, grant_type: "refresh_token", refresh_token: credentials.refresh_token },
        headers: { "x-action": "401", "x-client-id": token.clientId, "x-device-id": token.rawDeviceId, "x-device-sign": token.deviceId, "x-protocol-version": "301", "x-sdk-version": "3.4.20" },
      });
      if (!response.access_token) throw cloudFailure(context, response.error_code);
      credentials = { ...credentials, ...response, expires_at: new Date(Date.now() + (response.expires_in || 43200) * 1000).toISOString() };
      cloudSetStorage(token.credentialsKey, credentials);
    }
    if (force || !captcha?.token || expired(captcha.expires_at)) {
      const timestamp = String(Date.now());
      const host = new URL(context.url).hostname;
      let sign = `${token.clientId}1.92.62${host}${token.deviceId}${timestamp}`;
      for (const salt of ["o6b11ImBwJA1KSNMTALjL0xMkMjTP", "oVHCQaox9N6+R91GY63sbxci9K9ymFl", "XReS2zbwYB/+vUnYDwZ", "O56ssQHYiK5enUTKaV", "sGKNxaX7aUzpjJ2n+/2f1I0", "1oyQWde2s4zvz", "ziq13Yyc6HUXr3477c20PJfwBjg7ux", "xKMXTJmlEqamEpkWfp6WeP1qZezdCA", "rUA", "XVIzRTbY7MGdUXn0+qLjw", "aGrpbD3EUDGo0wmvaKPDGxVRaNVN6", "ieQk/"]) sign = cloudMd5(sign + salt);
      const response = await cloudRequest(context, "https://xluser-ssl.xunlei.com/v1/shield/captcha/init", { body: {
        client_id: token.clientId, action: "get:/drive/v1/about", device_id: token.deviceId,
        meta: { username: "", phone_number: "", email: "", package_name: host, client_version: "1.92.62", captcha_sign: `1.${sign}`, timestamp, user_id: credentials.user_id || "" },
      } });
      if (!response.captcha_token) throw cloudFailure(context, response.error_code);
      captcha = { token: response.captcha_token, expires_at: new Date(Date.now() + (response.expires_in || 300) * 1000).toISOString() };
      cloudSetStorage(`captcha_${token.clientId}`, captcha);
    }
    return { Authorization: `${credentials.token_type || "Bearer"} ${credentials.access_token}`, "X-Captcha-Token": captcha.token, "X-Device-Id": token.deviceId };
  }
  async function cloudXunlei(context) {
    let headers = await cloudOnce(context, "xunlei-token", () => cloudXunleiToken(context));
    const url = "https://api-pan.xunlei.com/drive/v1/files/" + encodeURIComponent(context.file.id);
    let response = await cloudRequest(context, url, { headers });
    if (response.error_code == 9) {
      headers = await cloudOnce(context, "xunlei-refresh", () => cloudXunleiToken(context, true));
      response = await cloudRequest(context, url, { headers });
    }
    if (response.error_code == 9) throw new Error("迅雷云盘的验证令牌已过期，请刷新网盘页面后重试");
    if (!response.web_content_link) throw cloudFailure(context, response.error_code, response.error_description);
    return cloudDownload(context, response.web_content_link);
  }

  // $guangya.getToken / getShareToken / getFileUrl.
  async function cloudGuangya(context) {
    const token = cloudCredentials();
    if (!token.credentials?.access_token || !token.deviceId) throw new Error("请先登录光鸭云盘，再刷新页面重试");
    const headers = { Authorization: `${token.credentials.token_type || "Bearer"} ${token.credentials.access_token}`,
      "X-Captcha-Token": token.captcha?.captcha_token || token.captcha?.token || "", "X-Device-Id": token.deviceId };
    const body = { fileId: context.file.fileId };
    if (context.share) body.accessToken = await cloudOnce(context, "guangya-share", async () => {
      const pageUrl = new URL(context.url);
      const response = await cloudRequest(context, "https://api.guangyapan.com/nd.bizuserres.s/v1/get_share_access_token", {
        body: { shareId: pageUrl.pathname.match(/\/(?:s|share)\/([^/?#]+)/)?.[1], code: pageUrl.searchParams.get("code") || cloudNode('input.ant-input[type="text"]')?.value || "" }, headers,
      });
      if (!response.data?.accessToken) throw cloudFailure(context, response.code, response.msg);
      return response.data.accessToken;
    });
    const response = await cloudRequest(context, `https://api.guangyapan.com/nd.bizuserres.s/v1/${context.share ? "get_share_download_url" : "get_res_download_url"}`, { body, headers });
    if (!response.data?.signedURL && !response.data?.downloadUrl) {
      if (response.code == 9) throw new Error("光鸭云盘页面验证已过期，请刷新网盘页面后重试");
      if (response.code == 103) throw new Error("光鸭云盘服务响应超时，请稍后重试");
      if (response.code == 207) throw new Error("分享者未开启免登录下载，请登录光鸭云盘后重试");
      throw cloudFailure(context, response.code, response.msg);
    }
    return cloudDownload(context, response.data.signedURL || response.data.downloadUrl);
  }

  // $quark / $uc.getLink, including share tokens and Quark's download cookie. Up to 15 fids per request, sent as the PC client.
  function quarkError(contexts, response) {
    const context = contexts[0];
    if (response.code == 31001) return new Error(`请先登录${context.label}，再刷新页面重试`);
    if (response.code == 23018) {
      const fid = String(response.message || "").match(/\[([a-f0-9]{32})\]/)?.[1];
      const name = contexts.find(item => String(item.file.fid) === fid)?.file.file_name;
      return new Error(`超出${context.label}游客可获取的文件大小，请登录后重试${name ? `（文件：${String(name).slice(0, 80)}）` : ""}`);
    }
    return cloudFailure(context, response.code, response.message);
  }
  async function cloudQuarkUcMany(contexts) {
    const context = contexts[0];
    const quark = context.provider === "quark";
    const identity = CLOUD_API_HEADERS[context.provider];
    const cookie = context.session.get("quark-cookie") || await cookieHeader(context.url);
    if (quark && !settings().cookies) throw new Error("夸克下载需要来源 Cookie，请先在脚本设置中启用携带 Cookie");
    let socialToken = "";
    if (quark) {
      try {
        socialToken = await cloudOnce(context, "quark-social", async () => {
          const time = Math.floor(Date.now() / 1000);
          const response = await cloudRequest(context, "https://drive-social-api.quark.cn/1/clouddrive/chat/conv/file/acquire_dl_token?pr=ucpro&fr=pc&sys=win32&ve=6.9.7.761&fr=win&la=zh-CN&ch=pckk%40product_guanwan", {
            body: { conversation_id: "300000" + time, conversation_type: 3, msg_id: time + "000" }, headers: { ...identity, ...(cookie ? { Cookie: cookie } : {}) },
          });
          if (response.code !== 0 || !response.data?.token) throw quarkError(contexts, response);
          return response.data.token;
        });
      } catch (error) { if (!context.share) throw error; }
    }
    const body = { fids: contexts.map(item => item.file.fid) };
    if (quark) { body.speedup_session = ""; body.token = socialToken; }
    if (context.share) {
      const pwdId = page.factStat?.ut?.baseParams?.pwd_id || page.factStat?.wa?.customStatParams?.pwd_id
        || new URL(context.url).pathname.match(/^\/(?:s|share)\/([^/?#]+)/)?.[1];
      if (!pwdId || contexts.some(item => !item.file.stoken || !item.file.share_fid_token)) throw new Error("请在分享网页完成提取码验证，打开文件列表后重试");
      Object.assign(body, { pwd_id: pwdId, stoken: context.file.stoken, fids_token: contexts.map(item => item.file.share_fid_token) });
    }
    const url = quark ? "https://drive-pc.quark.cn/1/clouddrive/file/download?pr=ucpro&fr=pc&sys=win32&ve=6.9.7.761"
      : "https://pc-api.uc.cn/1/clouddrive/file/download?pr=UCBrowser&fr=pc&sys=win32&ve=1.8.8";
    const result = await cloudRequest(context, url, { body, headers: { ...identity, ...(cookie ? { Cookie: cookie } : {}) }, withResponse: true });
    const response = result.data;
    const pugs = result.headers.match(/^set-cookie:\s*__pugs=([^;\r\n]+)/im)?.[1];
    const downloadCookie = quark && context.share
      ? pugs ? `__pugs=${pugs}` : cookie.split(";").map(part => part.trim()).find(part => part.startsWith("__pugs=")) || cookie
      : cookie;
    if (quark && pugs) context.session.set("quark-cookie", downloadCookie);
    if (response.code !== 0 || !Array.isArray(response.data)) throw quarkError(contexts, response);
    const headers = { "User-Agent": CLOUD_DOWNLOAD_UA[context.provider] };
    if (quark) headers.Cookie = downloadCookie;
    else headers["Sec-Ch-Ua"] = identity["Sec-Ch-Ua"];
    return contexts.map(item => {
      const file = response.data.find(entry => String(entry.fid) === String(item.file.fid));
      try { return file?.download_url ? cloudDownload(item, file.download_url, headers) : cloudFailure(item, response.code); } catch (error) { return error; }
    });
  }
  async function cloudQuarkUc(context) {
    const [result] = await cloudQuarkUcMany([context]);
    if (result instanceof Error) throw result;
    return result;
  }

  // $123pan.getFileUrl: v2 endpoints, dispatchList + downloadPath, and the params wrapper.
  async function cloud123(context) {
    const token = cloudStorage("authorToken");
    const file = context.file;
    const headers = { ...CLOUD_API_HEADERS["123pan"], Platform: "web", Platform_os: "123pan/v323(Windows10.0.26200)", "App-Version": "323", LoginUuid: cloudStorage("LoginUuid") || "", Devicename: "", "Mac-Addr": "" };
    if (token) headers.Authorization = `Bearer ${token}`;
    else if (!context.share) throw new Error("请先登录 123 云盘，再刷新页面重试");
    const body = context.share
      ? { ShareKey: new URL(context.url).pathname.split("/").filter(Boolean)[1], FileID: file.FileId, S3keyFlag: file.S3KeyFlag, Size: file.Size, Etag: file.Etag }
      : { driveId: 0, etag: file.Etag, fileId: file.FileId, s3keyFlag: file.S3KeyFlag, type: file.Type, fileName: file.FileName, size: file.Size };
    const response = await cloudRequest(context, `https://api.123pan.cn/api/v2/${context.share ? "share/download/info" : "file/download_info"}`, { body, headers });
    if (response.code == 5112) throw new Error("请先登录 123 云盘，再刷新页面重试");
    if (response.code == 5113) throw new Error("123 云盘提示本月可用下载流量不足，请在网盘中查看流量额度");
    if (!response.data?.dispatchList?.[0]?.prefix || !response.data?.downloadPath) throw cloudFailure(context, response.code, response.message);
    let url = response.data.dispatchList[0].prefix + response.data.downloadPath;
    const wrapped = new URL(url).searchParams.get("params");
    if (wrapped) { try { url = atob(wrapped.replace(/-/g, "+").replace(/_/g, "/")); } catch { throw cloudFailure(context); } }
    return cloudDownload(context, url);
  }

  const cloudSamePage = context => cloudOf()?.provider === context.provider && new URL(context.url).origin === location.origin;
  async function resolveCloud(context) {
    if (!cloudSamePage(context)) throw new Error("请返回原网盘页面，再重新获取文件");
    const resolvers = { baidu: cloudBaidu, aliyun: cloudAliyun, mcloud: cloudMobile, tcloud: cloudTelecom,
      xunlei: cloudXunlei, guangya: cloudGuangya, quark: cloudQuarkUc, uc: cloudQuarkUc, "123pan": cloud123 };
    return resolvers[context.provider](context);
  }
  /** Multi-file requests, where the provider's API takes several files at once (LinkSwift's batch getLink). */
  function cloudManyResolver(context) {
    if (context.provider === "quark" || context.provider === "uc") return cloudQuarkUcMany;
    if (context.provider === "baidu" && !context.share) return cloudBaiduMany;
    return null;
  }

  /**
   * Fetch links for many selected files the way LinkSwift does: fixed-size batches (one request per batch where the API
   * accepts several files, otherwise that many requests in parallel; Baidu share pages one at a time), resting CLOUD_PAUSE
   * between batches. Returns one promise per context, in order. If a multi-file request fails, its files are retried one by
   * one so a single problem file (or a size limit) does not fail the whole batch.
   */
  function cloudResolveAll(contexts) {
    const settled = contexts.map(() => { let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); promise.catch(() => {}); return { promise, resolve, reject }; });
    if (!contexts.length) return [];
    const first = contexts[0];
    const pace = first.provider === "baidu" && first.share ? { size: 1 } : CLOUD_PACE[first.provider] || { size: 15 };
    const many = pace.many ? cloudManyResolver(first) : null;
    const single = async index => {
      try { settled[index].resolve(await resolveCloud(contexts[index])); } catch (error) { settled[index].reject(error); }
    };
    void (async () => {
      for (let start = 0; start < contexts.length; start += pace.size) {
        const indexes = contexts.slice(start, start + pace.size).map((_, offset) => start + offset);
        if (!cloudSamePage(first)) { for (const index of indexes) settled[index].reject(new Error("请返回原网盘页面，再重新获取文件")); continue; }
        if (many) {
          try {
            const results = await many(indexes.map(index => contexts[index]));
            indexes.forEach((index, offset) => results[offset] instanceof Error ? settled[index].reject(results[offset]) : settled[index].resolve(results[offset]));
          } catch (error) {
            if (indexes.length === 1) settled[indexes[0]].reject(error);
            else for (const index of indexes) await single(index);
          }
        } else await Promise.all(indexes.map(single));
        if (start + pace.size < contexts.length) await cloudSleep(CLOUD_PAUSE);
      }
    })();
    return settled.map(item => item.promise);
  }

  // ---------- Cookie 与 curl ----------

  function cookieHeader(url) {
    return new Promise(resolve => {
      const fallback = () => {
        // 同站资源退回 document.cookie（读不到 HttpOnly）；跨站资源不附带。
        try { resolve(new URL(url).hostname === location.hostname ? document.cookie : ""); }
        catch { resolve(""); }
      };
      if (typeof GM_cookie === "undefined" || !GM_cookie.list) return fallback();
      const timer = setTimeout(fallback, 2000);
      try {
        GM_cookie.list({ url }, (cookies, error) => {
          clearTimeout(timer);
          if (error || !Array.isArray(cookies)) return fallback();
          resolve(cookies.map(item => `${item.name}=${item.value}`).join("; "));
        });
      } catch {
        clearTimeout(timer);
        fallback();
      }
    });
  }

  const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
  const referer = () => location.href.split("#")[0];
  /** iframe 里探测到的资源用所在框架的地址作 Referer，其余用当前页面。 */
  const refererFor = url => items.get(url)?.referer || referer();

  async function curlFor(url, withCookies = settings().cookies, extraHeaders = {}, name = "") {
    const headers = new Map([["user-agent", ["User-Agent", navigator.userAgent]], ["referer", ["Referer", refererFor(url)]]]);
    const cookie = withCookies ? await cookieHeader(url) : "";
    if (cookie) headers.set("cookie", ["Cookie", cookie]);
    for (const [key, value] of Object.entries(extraHeaders)) {
      if (!/^[\w-]+$/.test(key) || /[\r\n\x00]/.test(String(value))) throw new Error("来源请求头无效");
      if (key.toLowerCase() !== "cookie" || withCookies) headers.set(key.toLowerCase(), [key, String(value)]);
    }
    const lines = [`curl ${quote(url)} -L`, ...[...headers.values()].map(([key, value]) => `-H ${quote(key + ": " + value)}`)];
    if (name) lines.push(`-o ${quote(name)}`);
    return lines.join(" \\\n  ");
  }

  function fileName(url) {
    try {
      const parts = new URL(url);
      const last = decodeURIComponent(parts.pathname.split("/").filter(Boolean).pop() || "");
      return last || parts.hostname;
    } catch { return url; }
  }

  // ---------- Tessera API ----------

  const stoppedError = () => new DOMException("已停止", "AbortError");

  /** 同时收束完成、超时与取消；关闭面板不取消请求，只有显式停止才中止。 */
  function gmRequest(details, signal, maxBytes) {
    if (signal?.aborted) return Promise.reject(stoppedError());
    return new Promise((resolve, reject) => {
      let request, timer, settled = false;
      const finish = (error, response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        error ? reject(error) : resolve(response);
      };
      const abort = () => { finish(stoppedError()); request?.abort(); };
      const limit = response => {
        if (!maxBytes) return false;
        const length = Number((response.responseHeaders || "").match(/^content-length:\s*(\d+)/im)?.[1]) || response.total || 0;
        if (length <= maxBytes && (response.loaded || 0) <= maxBytes) return false;
        finish(new Error(details.sizeMessage || "资源超过浏览器上传的 64 MiB 上限，请使用服务器下载或先保存到本地"));
        request?.abort();
        return true;
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (details.timeout) timer = setTimeout(() => {
        finish(new Error(details.timeoutMessage || "浏览器请求超时"));
        request?.abort();
      }, details.timeout);
      try {
        request = gm.xhr({ ...details,
          onreadystatechange: response => { limit(response); },
          onprogress: response => { if (!settled && !limit(response)) details.onprogress?.(response); },
          upload: details.upload ? { onprogress: response => { if (!settled) details.upload.onprogress?.(response); } } : undefined,
          onload: response => { if (!limit(response)) finish(null, response); },
          onabort: () => finish(stoppedError()),
          onerror: () => finish(new Error(details.errorMessage || "浏览器请求失败")),
          ontimeout: () => finish(new Error(details.timeoutMessage || "浏览器请求超时")),
        });
      } catch (error) { finish(error); }
    });
  }

  const privateGrants = new Map(), privateViews = new Set();
  function privateClient() {
    let value = gm.get("private-client", "");
    if (!/^[a-f0-9]{64}$/.test(value)) {
      value = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, "0")).join("");
      gm.set("private-client", value);
    }
    return value;
  }
  const privateId = config => `${config.server}\n${config.key}`;
  const privateCurrent = config => privateGrants.get(privateId(config));
  function privateForget(config) {
    const id = privateId(config), previous = privateGrants.get(id);
    if (!previous) return;
    clearTimeout(previous.timer);
    privateGrants.delete(id);
    for (const current of batches) if (current.destination.private && current.mode === "local" && privateId(current.config || settings()) === id
        && current.entries.some(entry => ["downloading", "uploading", "saving"].includes(entry.state))) current.controller?.abort();
    for (const update of [...privateViews]) update();
    updateBatch();
  }
  function privateRemember(config, value) {
    const previous = privateCurrent(config);
    if (previous) clearTimeout(previous.timer);
    if (!value.access) return privateForget(config);
    const grant = { ...value, until: Date.now() + value.remaining_seconds * 1000, lastTouch: previous?.lastTouch || 0 };
    grant.timer = setTimeout(() => {
      // 上传过程会在服务器续期；到本地期限时只查询状态，不能靠轮询延长授权。
      void api("GET", "/api/v1/private/status", undefined, { config, timeout: 15000 }).then(state => {
        if (privateCurrent(config) !== grant) return;
        state.unlocked ? privateRemember(config, state) : privateForget(config);
      }).catch(() => { if (privateCurrent(config) === grant) privateForget(config); });
    }, Math.max(1000, value.remaining_seconds * 1000 + 50));
    privateGrants.set(privateId(config), grant);
    if (!previous || previous.access !== grant.access) for (const update of [...privateViews]) update();
    return grant;
  }
  async function privateGrant(config = settings()) {
    let grant = privateCurrent(config);
    if (!grant || grant.until <= Date.now()) {
      const state = await api("GET", "/api/v1/private/status", undefined, { config });
      if (!state.unlocked) { privateForget(config); throw Object.assign(new Error("私密空间已锁定，请先解锁"), { status: 423 }); }
      grant = privateRemember(config, state);
    }
    return grant;
  }
  function privateTouch(config = settings()) {
    const grant = privateCurrent(config);
    if (!grant || Date.now() - grant.lastTouch < 15000) return;
    grant.lastTouch = Date.now();
    void api("POST", "/api/v1/activity", { active: true }, { config, privateSpace: true }).catch(() => {});
  }
  async function privateLock(config = settings()) {
    try { await api("POST", "/api/v1/lock", {}, { config, privateSpace: true }); }
    finally { privateForget(config); }
  }

  /** 密码留在 Tessera 来源文档；密钥与授权只通过专用 MessagePort 交换，不使用全局消息传递秘密。 */
  async function ensurePrivate(config = settings()) {
    try { return await privateGrant(config); }
    catch (error) { if (error.status !== 423) throw error; }
    if (!panel) throw new Error("请打开面板后解锁私密空间");
    const host = panel, previous = host.layer;
    return await new Promise((resolve, reject) => {
      const origin = new URL(config.server).origin;
      const url = `${config.server.replace(/\/+$/, "")}/grabber/index.html`;
      let settled = false, channel = null, popup = null;
      const iframe = h("iframe", { title: "Tessera 私密空间解锁", src: url, referrerPolicy: "no-referrer",
        sandbox: "allow-scripts allow-same-origin allow-forms", allow: "publickey-credentials-get",
        style: "width:100%;height:420px;border:0;background:transparent" });
      const hint = h("p", { className: "hint" }, "密码仅在 Tessera 的安全页面输入；浏览器支持时可用通行密钥快捷解锁。");
      const fallback = h("button", { type: "button", className: "btn ghost", onclick: () => {
        popup = page.open(url, "_blank", "popup,width=460,height=560");
        if (!popup) hint.textContent = "解锁窗口被拦截，请允许弹出窗口后重试。";
      } }, "网页限制内嵌时，在独立小窗口解锁");
      const layer = h("div", { className: "layer private-unlock-layer", role: "dialog", "aria-label": "解锁私密空间" },
        h("header", {}, h("span", { className: "title" }, "解锁私密空间")),
        h("div", { className: "body" }, hint, iframe, fallback),
        h("footer", {}, h("span", { className: "spacer" }), h("button", { type: "button", className: "btn ghost", onclick: () => finish(null, stoppedError()) }, "取消")));
      const controller = { close: () => finish(null, stoppedError()), privateMode: true };
      function finish(grant, error) {
        if (settled) return;
        settled = true;
        window.removeEventListener("message", ready);
        channel?.port1.close(); popup?.close(); layer.remove();
        host.classList.remove("private-unlock-open");
        if (host.layer === controller) host.layer = previous || null;
        if (!previous) host.classList.remove("has-layer");
        if (error) reject(error);
        else resolve(privateRemember(config, { ...grant, unlocked: true }));
      }
      function ready(event) {
        if (event.origin !== origin || event.data?.type !== "tessera-private-ready"
            || event.source !== iframe.contentWindow && event.source !== popup) return;
        channel?.port1.close();
        channel = new MessageChannel();
        channel.port1.onmessage = message => { if (message.data?.type === "unlocked" && message.data.grant?.access) finish(message.data.grant); };
        event.source.postMessage({ type: "tessera-private-connect" }, origin, [channel.port2]);
        channel.port1.postMessage({ type: "init", key: config.key, client: privateClient() });
      }
      window.addEventListener("message", ready);
      host.layer = controller; host.classList.add("has-layer", "private-unlock-open"); host.append(layer);
      placePanel();
    });
  }

  async function api(method, path, body, { config = settings(), signal, contentType = "application/json", binary = false, onprogress, privateSpace = false,
    timeout = method === "PUT" ? 600000 : 180000 } = {}) {
    const { server, key } = config;
    if (!server || !key) return Promise.reject(new Error("请先在设置中填写 Tessera 地址和访问密钥"));
    const grant = privateSpace ? await privateGrant(config) : null;
    if (privateSpace) path = path.replace(/^\/api\/v1(?=\/)/, "/api/v1/private");
    const response = await gmRequest({
      method, url: server.replace(/\/+$/, "") + path, anonymous: true, timeout,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": contentType,
        ...(path.startsWith("/api/v1/private/") ? { "X-Tessera-Private-Client": privateClient() } : {}),
        ...(grant ? { "X-Private-Access": grant.access } : {}) },
      data: body === undefined ? undefined : binary ? body : JSON.stringify(body),
      upload: onprogress ? { onprogress } : undefined,
      errorMessage: "无法连接 Tessera，请检查地址，并在 Tampermonkey 提示时允许访问该域名",
      timeoutMessage: "请求 Tessera 超时",
    }, signal);
    let data = null;
    try { data = response.responseText ? JSON.parse(response.responseText) : null; } catch { /* 非 JSON */ }
    if (response.status >= 200 && response.status < 300) {
      if (grant && (method !== "GET" || path.startsWith("/api/v1/private/folders")))
        privateRemember(config, { ...grant, remaining_seconds: grant.idle_seconds });
      return data;
    }
    if (privateSpace && [401, 403, 423].includes(response.status)) privateForget(config);
    throw Object.assign(new Error(data?.error?.message || `Tessera 返回 HTTP ${response.status}`), { status: response.status });
  }

  // ---------- 浏览器下载 ----------

  const BROWSER_MAX_BYTES = 64 * 1024 * 1024;
  const BROWSER_EXTENSIONS = { "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp",
    "image/avif": ".avif", "image/heic": ".heic", "image/heif": ".heif", "image/bmp": ".bmp", "image/svg+xml": ".svg",
    "image/tiff": ".tiff", "image/x-icon": ".ico", "image/jxl": ".jxl", "image/jp2": ".jp2",
    "video/mp4": ".mp4", "video/webm": ".webm", "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "application/pdf": ".pdf" };
  const browserEligible = item => !item.cloud && item.type !== "stream" && !/\.(?:m3u8|mpd)(?:[?#]|$)/i.test(item.url);
  const sourceHeader = (headers, name) => (headers || "").match(new RegExp(`^${name}:\\s*(.*)$`, "im"))?.[1].trim() || "";
  const sourceError = (status, pageStatus, extension = false) => new Error(status === 401 || status === 403
    ? `${pageStatus ? `网页请求 HTTP ${pageStatus}，` : ""}来源拒绝${extension ? "扩展" : "网页"}请求（HTTP ${status}）。直接打开图片与脚本读取的权限可能不同；请先打开原图确认，仍失败时手动保存后上传`
    : `${extension ? "扩展" : "网页"}下载失败（HTTP ${status}）`);
  /** Cloudflare 人机验证只能在用户打开的页面里通过；后台请求遇到它时提示「打开验证」，通过后带上验证 Cookie 重试即可。 */
  const challengeError = () => Object.assign(new Error("来源启用了 Cloudflare 人机验证：点「打开验证」在新标签页完成验证后，再点重试"), { challenge: true });
  const isChallenge = (status, headers, prefix = "") => /^challenge$/i.test(sourceHeader(headers, "cf-mitigated"))
    || (status === 403 || status === 503) && /cloudflare/i.test(sourceHeader(headers, "server"))
      && /(?:Just a moment|cf-chl|challenge-platform|Attention Required)/i.test(prefix);
  // 与浏览器加载 <img>／媒体时的 Accept 一致，避免被当成脚本请求；User-Agent 保持浏览器自带的值（改写反而更像机器人）。
  const ACCEPT = { image: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8", video: "*/*", audio: "*/*" };

  async function validateBrowserFile(blob, type, contentType, mitigated) {
    if (!blob || typeof blob.slice !== "function" || !blob.size) throw new Error("来源未返回文件内容");
    if (blob.size > BROWSER_MAX_BYTES) throw new Error("资源超过浏览器上传的 64 MiB 上限，请使用服务器下载或先保存到本地");
    const mime = (contentType || blob.type || "").split(";", 1)[0].trim().toLowerCase();
    const prefix = await blob.slice(0, 1024).text();
    if (mitigated === "challenge") throw challengeError();
    if (/(?:text\/html|application\/xhtml\+xml)/.test(mime)
      || /^\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(prefix)
      || /<title>\s*(?:Just a moment|Attention Required)[\s!|]/i.test(prefix)) {
      throw new Error("来源返回了登录、验证或拦截页面，未上传；请先在网页中完成验证后重试");
    }
    if (/mpegurl|dash\+xml/i.test(mime) || /^\s*#EXTM3U\b/.test(prefix)) throw new Error("流媒体列表请使用服务器下载");
    const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
    const detected = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? "image/jpeg"
      : ascii(0, 8) === "\x89PNG\r\n\x1a\n" ? "image/png"
      : /^GIF8[79]a$/.test(ascii(0, 6)) ? "image/gif"
      : ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP" ? "image/webp"
      : ascii(0, 2) === "BM" ? "image/bmp"
      : ["II*\x00", "MM\x00*"].includes(ascii(0, 4)) ? "image/tiff"
      : ascii(0, 4) === "\x00\x00\x01\x00" ? "image/x-icon"
      : bytes[0] === 0xff && bytes[1] === 0x0a || ascii(4, 12) === "JXL \r\n\x87\n" ? "image/jxl"
      : ascii(4, 12) === "jP  \r\n\x87\n" ? "image/jp2"
      : ascii(4, 8) === "ftyp" && /avif|avis/.test(ascii(8, 12)) ? "image/avif"
      : ascii(4, 8) === "ftyp" && /heic|heix|hevc|hevx|mif1|msf1/.test(ascii(8, 12)) ? mime.startsWith("image/") ? mime : "image/heif"
      : /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(prefix) ? "image/svg+xml" : "";
    if (type === "image" && !detected) throw new Error("来源没有返回可识别的图片，未上传；请确认原图可以正常打开");
    return detected || mime || "application/octet-stream";
  }

  /** 图片优先尝试浏览器缓存；网页读取失败或返回 403 时，用扩展上下文与来源 Cookie 再请求一次。 */
  async function browserDownload(url, type, { signal, cookies, onprogress }) {
    if (!/^https?:\/\//i.test(url) || !browserEligible({ url, type })) throw new Error("浏览器上传只支持 HTTP(S) 文件直链，流媒体和平台视频请使用服务器下载");
    if (signal.aborted) throw stoppedError();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 180000);
    try {
      const extensionDownload = async pageStatus => {
        if (controller.signal.aborted) throw stoppedError();
        const cookie = cookies ? await cookieHeader(url) : "";
        const source = await gmRequest({ method: "GET", url, responseType: "blob", timeout: 180000,
          anonymous: !cookies, cookie: cookie || undefined,
          headers: { Accept: ACCEPT[type] || "*/*", Referer: refererFor(url) },
          onprogress: event => onprogress(event.loaded || 0, event.lengthComputable ? event.total : null),
          errorMessage: "浏览器无法读取资源，请允许 Tampermonkey 访问来源域名，或手动保存后上传",
          timeoutMessage: "浏览器下载超时，请重试",
        }, controller.signal, BROWSER_MAX_BYTES);
        if (source.status < 200 || source.status >= 300) {
          const prefix = source.response && typeof source.response.slice === "function" ? await source.response.slice(0, 4096).text().catch(() => "") : "";
          if (isChallenge(source.status, source.responseHeaders, prefix)) throw challengeError();
          throw sourceError(source.status, pageStatus, true);
        }
        const mime = await validateBrowserFile(source.response, type, sourceHeader(source.responseHeaders, "content-type"), sourceHeader(source.responseHeaders, "cf-mitigated"));
        return { blob: source.response, mime };
      };
      let response;
      try { response = await page.fetch(url, { credentials: cookies ? "include" : "omit", signal: controller.signal,
        ...(type === "image" ? { cache: "force-cache" } : {}) }); }
      catch {
        if (controller.signal.aborted) throw stoppedError();
        return await extensionDownload();
      }
      if (response.status === 403) { await response.body?.cancel(); return await extensionDownload(403); }
      if (!response.ok) { await response.body?.cancel(); throw sourceError(response.status); }
      const total = Number(response.headers.get("content-length")) || null;
      if (total > BROWSER_MAX_BYTES) { await response.body?.cancel(); throw new Error("资源超过浏览器上传的 64 MiB 上限，请使用服务器下载或先保存到本地"); }
      if (!response.body) throw new Error("浏览器无法读取文件内容，请使用最新版浏览器和 Tampermonkey");
      const reader = response.body.getReader();
      const chunks = [];
      let received = 0, complete = false;
      try {
        while (true) {
          if (controller.signal.aborted) throw stoppedError();
          const { done, value } = await reader.read();
          if (done) { complete = true; break; }
          received += value.byteLength;
          if (received > BROWSER_MAX_BYTES) throw new Error("资源超过浏览器上传的 64 MiB 上限，请使用服务器下载或先保存到本地");
          chunks.push(value);
          onprogress(received, total);
        }
      } finally {
        if (!complete) await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const blob = new Blob(chunks, { type: response.headers.get("content-type") || "" });
      const mime = await validateBrowserFile(blob, type, response.headers.get("content-type"), response.headers.get("cf-mitigated"));
      return { blob, mime };
    } catch (error) {
      if (timedOut) throw new Error("浏览器下载超时，请重试");
      if (signal.aborted) throw stoppedError();
      throw error.name === "TypeError" ? new Error("浏览器读取资源时连接中断，请重试") : error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }

  function defaultSaveName(url) {
    let name = fileName(url).replace(/[\\/\x00-\x1f\x7f]/g, "_").trim().replace(/^\.+|\.+$/g, "").normalize("NFC") || "file";
    if (name === ".tgdrive") name = "file";
    while (new TextEncoder().encode(name).length > 220) name = [...name].slice(0, -1).join("");
    return name;
  }

  function saveNameProblem(value) {
    const name = String(value || "").trim().normalize("NFC");
    if (!name) return "请填写保存文件名";
    if (/[\\/\x00-\x1f\x7f]/.test(value)) return "文件名不能包含路径或控制字符";
    if ([".", "..", ".tgdrive"].includes(name) || name.endsWith(".")) return "请填写有效文件名，不能使用保留名称或以点号结尾";
    if (new TextEncoder().encode(name).length > 220) return "文件名不能超过 220 字节，请缩短名称";
    return "";
  }

  function uploadSaveName(entry, mime) {
    let name = (entry.name ?? defaultSaveName(entry.url)).trim().normalize("NFC");
    if (!/\.[^.\s]+$/.test(name)) name += BROWSER_EXTENSIONS[mime] || "";
    const problem = saveNameProblem(name);
    if (problem) throw new Error(problem);
    return name;
  }

  /** PUT 先写入自己的临时名，再以 skip 移到确认名，目录事务保证同名文件不会被覆盖。 */
  function browserTemporaryName() {
    const suffix = [...crypto.getRandomValues(new Uint32Array(2))].map(value => value.toString(16).padStart(8, "0")).join("");
    return `.tessera-upload-${suffix}`;
  }

  // ---------- 界面 ----------

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; }
    [hidden] { display: none !important; }
    .root {
      --bg: #ffffff; --fg: #15161d; --muted: #6b6d7a; --faint: #a3a5b1; --line: rgba(20, 22, 40, .08); --line-strong: rgba(20, 22, 40, .16);
      --soft: rgba(20, 22, 40, .045); --hover: rgba(20, 22, 40, .04);
      /* 与 Tessera 网页同一套色彩：主按钮用墨色，青金蓝只用于选中、焦点、链接与进度。 */
      --accent: #3550d4; --accent-hover: #2b45bd; --accent-soft: rgba(53, 80, 212, .1); --amber: #f0a22e;
      --primary: #17171c; --primary-hover: #33333b; --on-primary: #ffffff;
      --danger: #e5484d; --success: #12a150;
      --grad: var(--accent);
      --glass: rgba(255, 255, 255, .9); --glass-line: rgba(255, 255, 255, .7);
      --text-md: 14px; --text-lg: 16px; --radius-lg: 10px; --radius-xl: 14px; --radius-panel: 20px;
      --shadow: 0 0 0 1px rgba(20, 22, 40, .06), 0 2px 6px rgba(20, 22, 40, .06), 0 24px 60px -12px rgba(30, 30, 80, .28);
      --glow: 0 1px 2px rgba(20, 22, 40, .12);
      --logo-bg: #0b0c13; --logo-tile: #fff; --logo-ring: transparent; --logo-plane: #f0a22e; --logo-fold: #c27a10;
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Segoe UI", sans-serif;
      color: var(--fg); -webkit-font-smoothing: antialiased;
    }
    @media (prefers-color-scheme: dark) {
      .root {
        --bg: #16171f; --fg: #f2f3f7; --muted: #9a9cab; --faint: #6c6e7d; --line: rgba(255, 255, 255, .08); --line-strong: rgba(255, 255, 255, .16);
        --soft: rgba(255, 255, 255, .06); --hover: rgba(255, 255, 255, .05);
        --accent: #8b9cff; --accent-hover: #a3b1ff; --accent-soft: rgba(139, 156, 255, .14); --danger: #ff6b70; --success: #3ddc84;
        --primary: #ededf0; --primary-hover: #ffffff; --on-primary: #0e0e11;
        --glass: rgba(22, 23, 32, .9); --glass-line: rgba(255, 255, 255, .08);
        --shadow: 0 0 0 1px rgba(255, 255, 255, .06), 0 2px 6px rgba(0, 0, 0, .3), 0 28px 70px -12px rgba(0, 0, 0, .7);
        --glow: 0 1px 2px rgba(0, 0, 0, .4);
        --logo-ring: rgba(255, 255, 255, .16);
      }
    }
    svg { display: block; flex: none; }
    .logo-bg { fill: var(--logo-bg); stroke: var(--logo-ring); } .logo-tile { fill: var(--logo-tile); }
    .logo-plane { fill: var(--logo-plane); stroke: var(--logo-plane); } .logo-fold { fill: none; stroke: var(--logo-fold); }

    /* 悬浮按钮：可拖动，松手后吸附到最近的左右边缘 */
    /* 小圆形底座内保留品牌标志，减少对网页内容的遮挡 */
    .fab { position: fixed; width: 36px; height: 36px; padding: 0; border-radius: 50%; border: 1px solid var(--logo-ring); background: var(--logo-bg);
      box-shadow: var(--shadow); display: grid; place-items: center; cursor: pointer; pointer-events: auto; touch-action: none;
      user-select: none; z-index: 2147483646; transition: top .2s ease, left .2s ease, transform .15s ease, opacity .15s; }
    .fab .logo-bg { fill: none; stroke: none; }
    .fab:hover { transform: scale(1.06); }
    .fab.dragging { transition: none; transform: scale(1.1); cursor: grabbing; }
    .fab:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .badge { position: absolute; top: -2px; right: -2px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px;
      background: var(--accent); color: #fff; font-size: 11px; font-weight: 600; line-height: 16px; text-align: center;
      box-shadow: 0 0 0 2px var(--bg); }

    /* 面板 */
    .panel { position: fixed; width: 480px; max-width: calc(100% - 24px); display: flex; flex-direction: column; overflow: hidden;
      background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius-panel); box-shadow: var(--shadow);
      pointer-events: auto; z-index: 2147483647; animation: rise .16s ease-out; }
    .panel.batch-panel { width: 560px; }
    .panel.is-sheet { width: auto; }
    .fab.is-dormant { opacity: .38; transform: scale(.82); }
    .fab.is-dormant:hover, .fab.is-dormant:focus-visible { opacity: 1; transform: none; }
    .fab.is-dormant .badge { display: none; }
    /* 只做位移不改透明度：动画被节流或暂停时面板仍然完整可见 */
    @keyframes rise { from { transform: translateY(6px); } }
    header { display: flex; align-items: center; gap: 10px; height: 56px; padding: 0 16px 0 24px; border-bottom: 1px solid var(--line); flex: none; }
    header .title { flex: 1; min-width: 0; font-size: var(--text-lg); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    header .back { margin-left: -6px; }
    .body { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 24px; display: grid; gap: 20px; align-content: start;
      grid-template-columns: minmax(0, 1fr); }
    footer { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 14px 24px; border-top: 1px solid var(--line); }
    footer .spacer { flex: 1; }
    .footer-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    @media (max-width: 420px) { .footer-actions { flex-basis: 100%; justify-content: flex-end; } }
    footer .site { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--muted); font-size: 12px; }
    footer .site span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    /* 按钮 */
    button { font: inherit; color: inherit; cursor: pointer; border: 0; background: none; }
    button:disabled { opacity: .45; cursor: default; }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .icon-btn { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 8px; color: var(--muted); flex: none; }
    .icon-btn:hover:not(:disabled) { background: var(--soft); color: var(--fg); }
    .icon-btn.accent { color: var(--accent); }
    .icon-btn.accent:hover:not(:disabled) { background: var(--accent-soft); color: var(--accent); }
    .btn { height: 34px; padding: 0 14px; border-radius: 9px; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      font-weight: 500; white-space: nowrap; background: var(--soft); }
    .btn:hover:not(:disabled) { background: var(--line); }
    .btn.primary { background: var(--accent); color: #fff; }
    .btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
    .btn.ghost { background: none; color: var(--muted); }
    .btn.ghost:hover:not(:disabled) { background: var(--soft); color: var(--fg); }
    .btn.block { flex: 1; }
    .text-btn { color: var(--muted); font-size: 12px; padding: 2px 4px; border-radius: 6px; }
    .text-btn:hover { color: var(--fg); background: var(--soft); }

    /* 当前页面（X 帖子 / YouTube 视频） */
    .hero { display: grid; gap: 12px; padding: 14px; border-radius: 12px; background: var(--soft); }
    .hero-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .hero-mark { width: 36px; height: 36px; border-radius: 10px; background: var(--bg); color: var(--accent); display: grid; place-items: center; flex: none; }
    .hero-text { min-width: 0; }
    .hero-text strong { display: block; font-weight: 600; }
    .hint { color: var(--muted); font-size: 12px; line-height: 1.55; }
    .actions { display: flex; gap: 8px; align-items: center; }
    .actions .icon-btn { background: var(--bg); width: 34px; height: 34px; border-radius: 9px; }

    /* 资源列表 */
    .section { display: grid; gap: 10px; grid-template-columns: minmax(0, 1fr); }
    .section-head { display: flex; align-items: center; gap: 8px; }
    .section-head h2 { font-size: 13px; font-weight: 600; }
    .count { color: var(--faint); font-weight: 400; margin-left: 4px; }
    .section-head .spacer { flex: 1; }
    .chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .chip { height: 26px; padding: 0 10px; border-radius: 13px; font-size: 12px; color: var(--muted); background: none; border: 1px solid var(--line); }
    .chip:hover { color: var(--fg); }
    .chip[aria-pressed=true] { background: var(--fg); border-color: var(--fg); color: var(--bg); }
    .list { display: grid; grid-template-columns: minmax(0, 1fr); margin: 0 -8px; }
    .item { display: flex; align-items: center; gap: 12px; min-height: 56px; padding: 8px; border-radius: 10px; }
    .item:hover { background: var(--hover); }
    .tile { width: 40px; height: 40px; border-radius: 9px; background: var(--soft); color: var(--muted); display: grid; place-items: center;
      flex: none; overflow: hidden; }
    .tile img { width: 100%; height: 100%; object-fit: cover; }
    .meta { flex: 1; min-width: 0; display: grid; gap: 2px; }
    .name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sub { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .item-actions { display: flex; gap: 2px; flex: none; }
    .item-actions:empty { display: none; }
    .empty { display: grid; justify-items: center; gap: 10px; padding: 28px 12px; color: var(--muted); text-align: center; font-size: 12px; }
    .empty .tile { width: 44px; height: 44px; border-radius: 12px; }
    .empty.loading .tile svg { animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* 选择文件 */
    .pick { cursor: pointer; }
    .check { width: 18px; height: 18px; border-radius: 5px; border: 1.5px solid var(--faint); display: grid; place-items: center; flex: none;
      color: transparent; transition: background .12s, border-color .12s; }
    .pick input { position: absolute; opacity: 0; pointer-events: none; }
    .pick input:checked + .check { background: var(--accent); border-color: var(--accent); color: #fff; }
    .pick input:focus-visible + .check { outline: 2px solid var(--accent); outline-offset: 2px; }
    .warn { color: #b7791f; font-size: 12px; white-space: normal; }

    /* 多选 */
    .item.selectable { cursor: pointer; }
    .item.is-selected { background: var(--accent-soft); }
    .item.is-selected:hover { background: var(--accent-soft); }
    .item.is-sent:not(.is-selected) .name { color: var(--muted); }
    .folder-tag { display: inline-flex; align-items: center; gap: 3px; max-width: 100%; margin-right: 6px; color: var(--muted); vertical-align: -1px; }
    .folder-tag svg { flex: none; }
    /* 网盘文件夹树 */
    .tree-body { gap: 12px; }
    .tree-head { display: flex; align-items: center; gap: 8px; position: sticky; top: -18px; z-index: 1; margin: -4px 0 0; padding: 4px 0 8px; background: var(--bg); border-bottom: 1px solid var(--line); }
    .tree-head .spacer { flex: 1; }
    .tree-all { font-weight: 500; }
    .tree-summary { color: var(--muted); font-size: 12px; white-space: nowrap; }
    .tree { display: grid; }
    .tree-row { display: flex; align-items: center; gap: 6px; min-height: 32px; padding: 0 6px 0 calc(var(--depth, 0) * 18px + 2px); border-radius: 6px; }
    .tree-row:hover { background: var(--hover); }
    .tree-row > svg { flex: none; color: var(--muted); }
    .tree-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tree-row.is-dir .tree-name { font-weight: 500; cursor: default; }
    .tree-meta { flex: none; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
    .tree-toggle, .tree-toggle-space { flex: none; width: 20px; height: 20px; }
    .tree-more { display: block; margin: 4px 0 4px calc(var(--depth, 0) * 18px + 54px); padding: 4px 10px; border: 0; border-radius: 6px; background: var(--soft); color: var(--accent); font-size: 12px; cursor: pointer; }
    .tree-more:hover { background: var(--hover); }
    .tree-toggle { display: grid; place-items: center; padding: 0; border: 0; border-radius: 4px; background: none; color: var(--muted); cursor: pointer; }
    .tree-toggle svg { transition: transform .12s; }
    .tree-toggle[aria-expanded="true"] svg { transform: rotate(90deg); }
    .tree-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .tree-pick { position: relative; display: inline-flex; }
    .check.partial svg { display: none; }
    .check.partial::after { content: ""; width: 8px; height: 2px; border-radius: 1px; background: #fff; }
    .sent-tag { display: inline-block; margin-right: 6px; padding: 0 5px; border-radius: 4px; background: var(--soft); color: var(--success);
      font-size: 11px; font-weight: 500; line-height: 16px; vertical-align: 1px; }
    .check.on { background: var(--accent); border-color: var(--accent); color: #fff; }
    .select-all { display: flex; align-items: center; gap: 8px; cursor: pointer; border-radius: 6px; }
    .select-all:focus-visible, .item.selectable:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    footer .selection { font-size: 12px; color: var(--muted); }

    /* 批量发送 */
    .batch-banner { display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 12px; border-radius: 12px; background: var(--accent-soft);
      color: var(--fg); text-align: left; }
    .batch-banner .meta { gap: 6px; }
    .banner-host { display: grid; gap: 8px; }
    .batch-banner > svg { color: var(--muted); }
    .overview { display: grid; gap: 8px; }
    .overview-line { display: flex; align-items: baseline; gap: 8px; }
    .overview-line strong { font-size: 15px; font-weight: 600; }
    .progress { height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; position: relative; }
    .progress > span { position: absolute; inset: 0 auto 0 0; border-radius: 2px; background: var(--accent); transition: width .3s ease; }
    .progress.done > span { background: var(--success); }
    .progress.failed > span { background: var(--danger); }
    .progress.indeterminate > span { width: 35% !important; animation: slide 1.2s ease-in-out infinite; }
    @keyframes slide { from { left: -35%; } to { left: 100%; } }
    .state { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .state.ok { color: var(--success); }
    .state.err { color: var(--danger); white-space: normal; overflow-wrap: anywhere; }
    .state.run { color: var(--accent); }
    .batch-host { display: grid; gap: 20px; grid-template-columns: minmax(0, 1fr); }
    .batch-list { margin: 0; gap: 2px; }
    .batch-item { align-items: flex-start; gap: 12px; min-height: 0; padding: 8px; }
    .batch-item:hover { background: var(--hover); }
    .batch-item > .item-actions { align-self: center; align-items: center; gap: 4px; }
    .batch-item .meta { gap: 3px; align-self: center; }
    .tile-wrap { position: relative; flex: none; }
    .tile-badge { position: absolute; right: -3px; bottom: -3px; width: 16px; height: 16px; border-radius: 50%; display: grid; place-items: center;
      background: var(--success); color: #fff; box-shadow: 0 0 0 2px var(--bg); }
    .tile-badge[hidden] { display: none; }
    .batch-item .state { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .batch-item .state.err { white-space: normal; }
    .progress.thin { height: 3px; margin-top: 3px; }
    /* 名称输入框与普通名称同一位置，看上去像可编辑的标题 */
    .name-input[type=text] { height: 30px; margin: -3px 0 -1px -8px; width: calc(100% + 8px); padding: 0 8px; border-color: transparent; border-radius: 7px;
      background: var(--soft); font-weight: 500; transition: border-color .15s, background .15s, box-shadow .15s; }
    .name-input[type=text]:hover:not(:disabled) { border-color: var(--line); background: var(--bg); }
    .name-input[type=text]:focus { border-color: var(--accent); background: var(--bg); }
    .name-input[type=text][aria-invalid=true] { border-color: var(--danger); background: var(--bg); }
    .name-input[type=text][aria-invalid=true]:focus { box-shadow: 0 0 0 3px color-mix(in srgb, var(--danger) 12%, transparent); }
    .btn.small { height: 28px; padding: 0 10px; font-size: 12px; gap: 4px; border-radius: 7px; }
    .action-sep { width: 1px; height: 16px; margin: 0 4px; background: var(--line); align-self: center; }
    .variant { height: 24px; min-width: 0; max-width: min(180px, 100%); padding: 0 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg);
      color: var(--fg); font: inherit; font-size: 12px; }
    .variant:focus { outline: none; border-color: var(--accent); }
    .batch-item .sub { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; white-space: normal; }
    .batch-item .warn { font-size: 12px; }
    .batch-host > .dest { min-height: 0; }
    .batch-note, .rounds-note { display: flex; align-items: flex-start; gap: 8px; }
    .batch-note > svg, .rounds-note > svg { flex: none; margin-top: 2px; }
    .rounds-note { margin: 0 0 8px; padding: 8px 10px; border-radius: 8px; background: var(--accent-soft); color: var(--fg); }
    @media (max-width: 560px) {
      header { padding-left: 16px; padding-right: 12px; }
      .body { padding: 16px; }
      footer { padding: 12px 16px; }
      .name-input[type=text] { font-size: 16px; }
    }

    /* 表单 */
    .field { display: grid; gap: 6px; }
    .label { font-size: 12px; font-weight: 500; color: var(--muted); }
    input[type=text], input[type=password], input[type=url], input[type=number] { width: 100%; height: 36px; font: inherit; color: inherit;
      background: var(--bg); border: 1px solid var(--line); border-radius: 9px; padding: 0 11px; }
    input::placeholder { color: var(--faint); }
    input[type=text]:focus, input[type=password]:focus, input[type=url]:focus, input[type=number]:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    textarea { width: 100%; min-height: 96px; resize: vertical; font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; color: inherit;
      background: var(--bg); border: 1px solid var(--line); border-radius: 9px; padding: 8px 11px; }
    textarea::placeholder { color: var(--faint); font-family: inherit; }
    textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    /* 保存位置：一行摘要 + 「更改」，选择器是覆盖在当前面板上的一层，不丢失面板里的勾选和改名 */
    .dest { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; }
    .dest .meta { gap: 1px; }
    .dest .label { font-size: 11px; }
    .dest .name { font-weight: 500; }
    .dest.private { border-color: color-mix(in srgb, var(--accent) 35%, var(--line)); background: var(--accent-soft); }
    /* 选择层覆盖在面板上，面板内容较少时撑高到能浏览目录的高度 */
    .panel.has-layer { min-height: min(440px, calc(100vh - 96px)); }
    .panel.private-unlock-open { min-height: min(660px, var(--panel-available, calc(100vh - 96px))); }
    .private-unlock-layer > .body { display: flex; flex-direction: column; gap: 12px; }
    .private-unlock-layer > .body > iframe { flex: 1 0 360px; }
    .layer { position: absolute; inset: 0; z-index: 3; display: flex; flex-direction: column; background: var(--bg); animation: rise .14s ease-out; }
    .crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; font-size: 12px; color: var(--muted); }
    .crumbs button { height: 24px; max-width: 100%; padding: 0 6px; border-radius: 6px; color: var(--muted);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .crumbs button:hover { background: var(--hover); color: var(--fg); }
    .crumbs button[aria-current] { color: var(--fg); font-weight: 600; }
    .folder-row { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 40px; padding: 0 10px; border-radius: 8px; text-align: left; color: var(--fg); }
    .folder-row:hover { background: var(--hover); }
    .folder-row .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .folder-row > svg { color: var(--muted); }
    .new-folder { display: flex; gap: 6px; }
    .new-folder input { flex: 1; min-width: 0; }
    .private-note { display: grid; gap: 10px; padding: 14px; border-radius: 10px; background: var(--soft); color: var(--muted); font-size: 12px; line-height: 1.6; }
    .private-note strong { color: var(--fg); font-size: 13px; }
    .segmented { display: grid; grid-template-columns: 1fr 1fr; gap: 2px; padding: 2px; border-radius: 9px; background: var(--soft); }
    .segmented button { height: 30px; border-radius: 7px; font-size: 12px; color: var(--muted); }
    .segmented button[aria-checked=true] { background: var(--bg); color: var(--fg); font-weight: 500; box-shadow: 0 1px 2px rgba(0,0,0,.08); }
    .switch-row { display: flex; align-items: flex-start; gap: 12px; cursor: pointer; }
    .switch-row .meta { gap: 1px; }
    .switch-row .name { white-space: normal; }
    .switch-row .sub { white-space: normal; }
    .switch { position: relative; width: 34px; height: 20px; flex: none; margin-top: 1px; }
    .switch input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
    .switch span { position: absolute; inset: 0; border-radius: 10px; background: var(--line); transition: background .15s; pointer-events: none; }
    .switch span::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff;
      box-shadow: 0 1px 2px rgba(0,0,0,.2); transition: transform .15s; }
    .switch input:checked + span { background: var(--accent); }
    .switch input:checked + span::after { transform: translateX(14px); }
    .switch input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 2px; }
    .group { display: grid; gap: 14px; }
    .divider { height: 1px; background: var(--line); }
    .status { font-size: 12px; color: var(--muted); display: flex; gap: 6px; align-items: flex-start; }
    .status.ok { color: var(--success); }
    .status.error, .error { color: var(--danger); font-size: 12px; overflow-wrap: anywhere; }
    .actions-row { display: flex; flex-wrap: wrap; gap: 8px; }

    /* 完成 */
    .result { display: grid; justify-items: center; gap: 8px; padding: 16px 0 4px; text-align: center; }
    .result .tile { width: 48px; height: 48px; border-radius: 50%; background: var(--accent-soft); color: var(--accent); }
    .result strong { font-size: 15px; font-weight: 600; }
    .result .sub { white-space: normal; overflow-wrap: anywhere; }

    .toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); padding: 8px 14px; border-radius: 10px;
      background: var(--fg); color: var(--bg); font-size: 12px; box-shadow: var(--shadow); z-index: 2147483647; pointer-events: none;
      max-width: 80vw; animation: rise .16s ease-out; }

    /* ===== 视觉层：毛玻璃面板、品牌渐变与网格视图（覆盖上面的基础样式） ===== */
    .panel { background: var(--glass); border: 1px solid var(--glass-line); box-shadow: var(--shadow);
      -webkit-backdrop-filter: blur(24px) saturate(1.6); backdrop-filter: blur(24px) saturate(1.6);
      animation: pop .22s cubic-bezier(.2, .9, .3, 1.2); transform-origin: bottom right; }
    /* 只做缩放位移不改透明度：动画被节流或暂停时面板仍然完整可见 */
    @keyframes pop { from { transform: translateY(8px) scale(.97); } }
    .panel > * { position: relative; z-index: 1; }
    .panel > .layer { position: absolute; z-index: 3; }
    header { height: 60px; padding: 0 12px 0 18px; border-bottom: 1px solid var(--line); gap: 12px; }
    .brand-mark { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; box-shadow: 0 6px 16px -6px rgba(11, 12, 19, .6); }
    .title-block { flex: 1; min-width: 0; display: grid; line-height: 1.25; }
    .title-block .title { font-size: 15px; font-weight: 650; letter-spacing: -.01em; }
    .subtitle { font-size: 11px; color: var(--muted); letter-spacing: .02em; }
    .body { padding: 18px 18px 20px; gap: 16px; }
    footer { padding: 12px 18px; background: color-mix(in srgb, var(--bg) 40%, transparent); }
    @media (max-width: 560px) { header { padding-left: 14px; } .body { padding: 14px; } footer { padding: 12px 14px; } }

    /* 按钮：主按钮用墨色（与 Tessera 网页一致），行内操作平时低调、悬停时才用强调色 */
    .icon-btn { border-radius: 9px; transition: background .15s, color .15s, transform .15s; }
    .icon-btn:active:not(:disabled) { transform: scale(.92); }
    .btn { height: 34px; border-radius: 10px; transition: background .15s, box-shadow .2s, transform .15s, filter .15s; }
    .btn:active:not(:disabled) { transform: translateY(1px); }
    .btn.primary { background: var(--primary); color: var(--on-primary); box-shadow: var(--glow); }
    .btn.primary:hover:not(:disabled) { background: var(--primary-hover); }
    .icon-btn.accent { color: var(--muted); background: transparent; }
    .item:hover .icon-btn.accent, .item:focus-within .icon-btn.accent { color: var(--accent); background: var(--accent-soft); }
    .icon-btn.accent:hover:not(:disabled) { color: #fff; background: var(--accent); }
    .item.is-selected .icon-btn.accent { color: var(--accent); background: var(--accent-soft); }

    /* 悬浮按钮：深色底座 + 渐变光环，角标用品牌琥珀色 */
    .fab { width: 42px; height: 42px; border: 0; background: radial-gradient(circle at 30% 25%, #2a2c3d, #0b0c13 70%);
      box-shadow: 0 0 0 1.5px rgba(255, 255, 255, .08), 0 8px 24px -6px rgba(11, 12, 19, .55), 0 0 0 4px rgba(53, 80, 212, 0); }
    .fab::after { content: ""; position: absolute; inset: -2px; border-radius: 50%; padding: 2px; background: var(--grad); opacity: .0;
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude; transition: opacity .2s; }
    .fab:hover::after, .fab.has-items::after { opacity: 1; }
    .fab:hover { transform: scale(1.08); box-shadow: 0 0 0 1.5px rgba(255, 255, 255, .1), 0 12px 30px -6px rgba(11, 12, 19, .55); }
    .badge { top: -3px; right: -3px; min-width: 18px; height: 18px; border-radius: 9px; line-height: 18px; background: var(--amber); color: #1a1205;
      box-shadow: 0 0 0 2px #0b0c13; z-index: 1; }

    /* 标签与筛选 */
    .chip { height: 28px; padding: 0 12px; border-radius: 14px; border: 0; background: var(--soft); transition: background .15s, color .15s; }
    .chip:hover { background: var(--line-strong); }
    .chip-toggle { margin-left: auto; }
    .chip[aria-pressed=true] { background: var(--accent-soft); color: var(--accent); font-weight: 600; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent); }
    .section-head h2 { font-size: 13px; font-weight: 650; }
    .check { border-radius: 6px; }
    .check.on, .pick input:checked + .check { background: var(--grad); border-color: transparent; }

    /* 资源行 */
    .list { margin: 0 -6px; gap: 2px; }
    .item { --row-bg: var(--bg); gap: 12px; min-height: 60px; padding: 8px 8px; border-radius: 12px; transition: background .15s; }
    .item:hover { background: var(--hover); }
    .item.is-selected, .item.is-selected:hover { background: var(--accent-soft); }
    .tile { width: 44px; height: 44px; border-radius: 11px; background: var(--soft); box-shadow: inset 0 0 0 1px var(--line); }
    .tile img { transition: transform .3s ease; }
    .item:hover .tile img { transform: scale(1.06); }
    .name { font-weight: 550; }
    .sent-tag { background: color-mix(in srgb, var(--success) 14%, transparent); }
    .item-actions { align-items: center; }
    .secondary { display: flex; align-items: center; gap: 2px; }
    @media (hover: hover) {
      .item .secondary { max-width: 0; overflow: hidden; opacity: 0; transition: max-width .2s ease, opacity .15s ease; }
      .item:hover .secondary, .item:focus-within .secondary { max-width: 120px; opacity: 1; }
    }
    .view-toggle { width: 28px; height: 28px; }

    /* 网格视图：同一行元素变成缩略图卡片 */
    .list.grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 0; }
    .list.grid .item { position: relative; flex-direction: column; align-items: stretch; gap: 6px; min-height: 0; padding: 6px 6px 8px;
      background: var(--soft); }
    .list.grid .item:hover { background: var(--line); }
    .list.grid .item.is-selected { background: var(--accent-soft); box-shadow: inset 0 0 0 2px var(--accent); }
    .list.grid .tile { width: 100%; height: auto; aspect-ratio: 4 / 3; border-radius: 9px; }
    .list.grid .tile svg { width: 26px; height: 26px; }
    .list.grid .check { position: absolute; top: 12px; left: 12px; z-index: 1; background: rgba(255, 255, 255, .9); border-color: rgba(0, 0, 0, .25);
      opacity: 0; transition: opacity .15s; }
    .list.grid .item:hover .check, .list.grid .item.is-selected .check, .list.grid .item:focus-visible .check { opacity: 1; }
    .list.grid .check.on { background: var(--grad); border-color: transparent; }
    .list.grid .meta { padding: 0 2px; }
    .list.grid .name { font-size: 12px; }
    .list.grid .sub { font-size: 11px; }
    .list.grid .secondary { display: none; }
    .list.grid .item-actions { position: absolute; top: 10px; right: 10px; gap: 4px; opacity: 0; transition: opacity .15s; }
    .list.grid .item:hover .item-actions, .list.grid .item:focus-within .item-actions { opacity: 1; }
    .list.grid .item-actions .icon-btn { width: 28px; height: 28px; border-radius: 50%; background: rgba(15, 16, 24, .62); color: #fff;
      -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); }
    .list.grid .item-actions .icon-btn.accent { background: var(--grad); }
    @media (hover: none) { .list.grid .item-actions, .list.grid .check { opacity: 1; } }
    @media (max-width: 560px) { .list.grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }

    /* 卡片、保存位置与进度 */
    .hero { border-radius: 14px; background: var(--soft); box-shadow: inset 0 0 0 1px var(--line); }
    .hero-mark { background: var(--grad); color: #fff; box-shadow: var(--glow); }
    .dest { border-radius: 14px; border-color: var(--line); background: var(--soft); }
    .dest .tile { width: 36px; height: 36px; background: var(--bg); }
    .dest.private { background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 30%, transparent); }
    .dest.private .tile { background: var(--grad); color: #fff; box-shadow: var(--glow); }
    /* 批次状态：横幅与进度页摘要共用状态图标与语气色（run 渐变、ok 绿、warn 琥珀、err 红） */
    .status-icon { width: 36px; height: 36px; border-radius: 11px; display: grid; place-items: center; flex: none; color: #fff; background: var(--grad); box-shadow: var(--glow); }
    .tone-run .status-icon svg { animation: spin 1s linear infinite; }
    .tone-ok .status-icon { background: linear-gradient(135deg, #22c55e, #12a150); box-shadow: 0 6px 18px -6px rgba(18, 161, 80, .55); }
    .tone-warn .status-icon { background: linear-gradient(135deg, #f5b544, #e08a12); box-shadow: 0 6px 18px -6px rgba(224, 138, 18, .5); }
    .tone-err .status-icon { background: linear-gradient(135deg, #ff6b6f, #e5484d); box-shadow: 0 6px 18px -6px rgba(229, 72, 77, .5); }
    .batch-banner { position: relative; display: flex; align-items: center; padding: 0; border-radius: 14px; background: var(--soft);
      box-shadow: inset 0 0 0 1px var(--line); transition: box-shadow .15s, background .15s; }
    .batch-banner.tone-run { background: var(--accent-soft); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent); }
    .batch-banner:hover { box-shadow: inset 0 0 0 1px var(--line-strong); }
    .banner-open { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; padding: 10px 12px; text-align: left; border-radius: 14px; }
    .banner-open .meta { gap: 2px; }
    .banner-open .name { font-weight: 600; }
    .banner-open > svg { color: var(--faint); }
    .banner-open .status-icon { width: 32px; height: 32px; border-radius: 10px; }
    .banner-close { margin-right: 8px; }
    .overview { display: grid; gap: 12px; padding: 14px 16px; border-radius: 16px; background: var(--soft); box-shadow: inset 0 0 0 1px var(--line); }
    .overview-line { display: flex; align-items: center; gap: 12px; }
    .overview-line .meta { gap: 1px; }
    .overview-line strong { font-size: 15px; font-weight: 650; }
    .overview-line .sub { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .stats { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
    .stat { height: 22px; padding: 0 9px; border-radius: 11px; font-size: 12px; font-weight: 600; line-height: 22px; white-space: nowrap; }
    .stat.ok { color: var(--success); background: color-mix(in srgb, var(--success) 13%, transparent); }
    .stat.err { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }
    .stat.run { color: var(--accent); background: var(--accent-soft); }
    .overview .progress { height: 6px; }
    .overview:not(.tone-run) .progress { display: none; }
    /* 进度页的行：清除按钮在悬停时出现，触屏始终显示 */
    @media (hover: hover) {
      .batch-item .row-clear { opacity: 0; transition: opacity .15s; }
      .batch-item:hover .row-clear, .batch-item:focus-within .row-clear { opacity: 1; }
    }
    .batch-item .tile { width: 44px; height: 44px; }
    .batch-item .state.ok { font-weight: 500; }
    .progress { height: 5px; border-radius: 3px; background: var(--soft); }
    .progress > span { background: var(--grad); border-radius: 3px; }
    .progress:not(.done):not(.failed):not(.indeterminate) > span::after { content: ""; position: absolute; inset: 0;
      background: linear-gradient(90deg, transparent, rgba(255, 255, 255, .45), transparent); animation: shimmer 1.4s linear infinite; }
    @keyframes shimmer { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
    .progress.thin { height: 3px; }
    .progress.done > span { background: var(--success); }
    .progress.failed > span { background: var(--danger); }
    .tile-badge { background: var(--success); box-shadow: 0 0 0 2px var(--bg), 0 2px 6px rgba(18, 161, 80, .4); }
    .name-input[type=text] { background: var(--soft); border-radius: 8px; }
    .name-input[type=text]:focus { box-shadow: 0 0 0 3px var(--accent-soft); }
    .segmented { background: var(--soft); border-radius: 10px; }
    .segmented button[aria-checked=true] { color: var(--accent); font-weight: 600; box-shadow: 0 1px 3px rgba(20, 22, 40, .12); }
    .result .tile { background: var(--grad); color: #fff; box-shadow: var(--glow); }
    .switch input:checked + span { background: var(--grad); }
    .empty .tile { background: var(--soft); }
    .toast { border-radius: 12px; padding: 9px 16px; background: rgba(20, 21, 30, .92); color: #fff;
      -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); box-shadow: 0 12px 30px -8px rgba(0, 0, 0, .45); }

    /* 行内「更多」只在底部抽屉里出现；桌面仍是悬停浮现的次要操作。 */
    .more-btn { display: none; }
    .panel.is-sheet .item .secondary, .panel.is-sheet .item .local-btn { display: none; }
    .panel.is-sheet .more-btn { display: grid; }
    .panel.is-sheet .list:not(.grid) .item { gap: 10px; }
    .panel.is-sheet .list.grid .item-actions { top: 8px; right: 8px; }
    .panel.is-sheet .list.grid .item-actions .icon-btn { width: 32px; height: 32px; min-width: 32px; min-height: 32px; }

    /* 底部抽屉：贴底通栏，顶部圆角加拖动条示意，底部让出 Home 指示条。 */
    .panel.is-sheet { max-width: none; border-width: 1px 0 0; border-radius: 20px 20px 0 0; transform-origin: bottom center;
      box-shadow: 0 -12px 40px -12px rgba(0, 0, 0, .35); animation: sheet-up .24s cubic-bezier(.2, .9, .3, 1); }
    .panel.is-sheet::after { content: ""; position: absolute; top: 6px; left: 50%; width: 36px; height: 4px; margin-left: -18px; border-radius: 2px;
      background: var(--faint); opacity: .55; pointer-events: none; z-index: 4; }
    .panel.is-sheet > header { padding-top: 6px; }
    .panel.is-sheet > footer, .panel.is-sheet .layer > footer { padding-bottom: calc(12px + env(safe-area-inset-bottom)); }
    .panel.is-sheet:not(:has(> footer)) > .body { padding-bottom: calc(14px + env(safe-area-inset-bottom)); }
    @keyframes sheet-up { from { transform: translateY(24px); } }
    .panel.is-sheet > footer .footer-actions { flex: 1 1 100%; }
    .panel.is-sheet > footer .footer-actions > .btn { flex: 1 1 0; min-width: 0; }

    /* 面板内的操作菜单（同样只做位移动画，不改透明度） */
    .action-sheet { position: absolute; inset: 0; z-index: 5; display: flex; flex-direction: column; justify-content: flex-end; padding: 10px;
      padding-bottom: calc(10px + env(safe-area-inset-bottom)); background: rgba(10, 11, 18, .32); }
    .action-card { display: grid; gap: 2px; padding: 6px; border-radius: 16px; background: var(--bg); border: 1px solid var(--line);
      box-shadow: 0 18px 40px -12px rgba(0, 0, 0, .4); animation: sheet-up .2s cubic-bezier(.2, .9, .3, 1); }
    .action-head { display: grid; gap: 2px; padding: 8px 12px 10px; margin-bottom: 2px; border-bottom: 1px solid var(--line); min-width: 0; }
    .action-head strong { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .action-head span { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .action-item { display: flex; align-items: center; gap: 12px; min-height: 46px; padding: 0 12px; border-radius: 10px; text-align: left; color: var(--fg); }
    .action-item svg { color: var(--muted); flex: none; }
    .action-item:hover:not(:disabled), .action-item:focus-visible { background: var(--soft); outline: none; }
    .action-item.accent, .action-item.accent svg { color: var(--accent); }
    .action-label { display: grid; gap: 1px; min-width: 0; }
    .action-label small { color: var(--muted); font-size: 11px; }
    .action-cancel { min-height: 44px; margin-top: 4px; border-radius: 10px; background: var(--soft); font-weight: 500; }
    @media (prefers-reduced-motion: reduce) { .panel.is-sheet, .action-sheet, .action-card { animation: none; } }

    /* 窄屏把操作放到独立一行，避免触屏按钮挤掉名称或越过面板。 */
    @media (max-width: 560px) {
      /* 确认页：重试／移除放在名称右侧一列（顶端对齐），不再单独占一行。 */
      .batch-item { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; align-items: start; gap: 6px 8px; }
      .batch-item > .item-actions { grid-column: 3; grid-row: 1; align-self: start; flex-wrap: nowrap; gap: 0; margin-right: -4px; }
      .batch-item > .item-actions:empty { display: none; }
      .batch-item:has(> .item-actions:empty) { grid-template-columns: 44px minmax(0, 1fr); }
      .batch-item .sub { overflow-wrap: anywhere; }
      .overview-line { display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: 8px 12px; }
      .overview-line .stats { grid-column: 2; justify-content: flex-start; }
      footer .btn { max-width: 100%; height: auto; min-height: 40px; padding-top: 8px; padding-bottom: 8px;
        white-space: normal; overflow-wrap: anywhere; }
    }
    /* 放在控件基础样式之后，确保 iOS Safari 聚焦输入时不因小字号自动放大页面。 */
    @media (hover: none) and (pointer: coarse) {
      input[type=text], input[type=password], input[type=url], textarea, select, .variant { font-size: 16px; }
      .variant { min-height: 36px; }
      .icon-btn { min-width: 40px; min-height: 40px; }
      .btn { min-height: 40px; }
    }
  `;

  // 线条图标（24×24，描边）。YouTube 等站点启用了 Trusted Types，禁止给 innerHTML 赋字符串，所有节点都用 DOM API 创建。
  const ICONS = {
    settings: ["M20 7h-9", "M14 17H5", ["circle", { cx: 17, cy: 17, r: 3 }], ["circle", { cx: 7, cy: 7, r: 3 }]],
    close: ["M18 6 6 18", "m6 6 12 12"],
    folder: ["M3 7.5A1.5 1.5 0 0 1 4.5 6h4.2l2 2h8.8A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"],
    folderPlus: ["M3 7.5A1.5 1.5 0 0 1 4.5 6h4.2l2 2h8.8A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z", "M12 11v5", "M9.5 13.5h5"],
    lock: [["rect", { x: 5, y: 11, width: 14, height: 10, rx: 2 }], "M8 11V8a4 4 0 0 1 8 0v3"],
    home: ["M4 11 12 4l8 7", "M6 10v10h12V10"],
    back: ["m15 18-6-6 6-6"],
    link: ["M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71", "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"],
    terminal: ["m4 17 6-6-6-6", "M12 19h8"],
    send: ["M12 13v8", "m8 17 4-4 4 4", "M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"],
    video: [["rect", { x: 2, y: 4, width: 20, height: 16, rx: 3 }], "m10 9 5 3-5 3z"],
    audio: ["M9 18V5l12-2v13", ["circle", { cx: 6, cy: 18, r: 3 }], ["circle", { cx: 18, cy: 16, r: 3 }]],
    stream: ["M12 12H3", "M16 6H3", "M12 18H3", "m16 12 5 3-5 3v-6Z"],
    file: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4"],
    image: [["rect", { x: 3, y: 3, width: 18, height: 18, rx: 2 }], ["circle", { cx: 9, cy: 9, r: 2 }], "m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"],
    check: ["M20 6 9 17l-5-5"],
    more: [["circle", { cx: 5, cy: 12, r: 1.2 }], ["circle", { cx: 12, cy: 12, r: 1.2 }], ["circle", { cx: 19, cy: 12, r: 1.2 }]],
    minus: ["M5 12h14"],
    retry: ["M3 12a9 9 0 0 1 15-6.7L21 8", "M21 3v5h-5", "M21 12a9 9 0 0 1-15 6.7L3 16", "M3 21v-5h5"],
    chevron: ["m9 18 6-6-6-6"],
    search: [["circle", { cx: 11, cy: 11, r: 8 }], "m21 21-4.3-4.3"],
    loader: ["M21 12a9 9 0 1 1-6.22-8.56"],
    alert: [["circle", { cx: 12, cy: 12, r: 10 }], "M12 8v4", "M12 16h.01"],
    download: ["M12 3v12", "m7 10 5 5 5-5", "M5 21h14"],
    upload: ["M12 16V3", "m7 8 5-5 5 5", "M5 21h14"],
    grid: [["rect", { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }], ["rect", { x: 14, y: 3, width: 7, height: 7, rx: 1.5 }], ["rect", { x: 3, y: 14, width: 7, height: 7, rx: 1.5 }], ["rect", { x: 14, y: 14, width: 7, height: 7, rx: 1.5 }]],
    rows: ["M8 6h13", "M8 12h13", "M8 18h13", "M3 6h.01", "M3 12h.01", "M3 18h.01"],
    external: ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
    shield: ["M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z", "m9 12 2 2 4-4"],
    globe: [["circle", { cx: 12, cy: 12, r: 10 }], "M2 12h20", "M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"],
    x: ["M4 4l16 16", "M20 4 4 20"],
    youtube: [["rect", { x: 2, y: 5, width: 20, height: 14, rx: 4 }], "m10 9 5 3-5 3z"],
    sparkle: ["M12 3v4", "M12 17v4", "M3 12h4", "M17 12h4", "m6.3 6.3 2.1 2.1", "m15.6 15.6 2.1 2.1", "m6.3 17.7 2.1-2.1", "m15.6 8.4 2.1-2.1"],
  };
  const TYPE_ICON = { video: "video", audio: "audio", stream: "stream", image: "image", file: "file" };

  function svg(name, size = 16, width = 1.8) {
    const ns = "http://www.w3.org/2000/svg";
    const node = document.createElementNS(ns, "svg");
    for (const [key, value] of Object.entries({ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
      "stroke-width": width, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) node.setAttribute(key, value);
    for (const part of ICONS[name]) {
      const [tag, attrs] = typeof part === "string" ? ["path", { d: part }] : part;
      const child = document.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attrs)) child.setAttribute(key, value);
      node.append(child);
    }
    return node;
  }
  const icon = () => svg("download", 20, 2);

  /** Tessera 标志，几何与 web/src/ui.tsx 的 LogoMark 一致，颜色取自 --logo-* 令牌。 */
  function logo(size = 24) {
    const ns = "http://www.w3.org/2000/svg";
    const node = document.createElementNS(ns, "svg");
    for (const [key, value] of Object.entries({ viewBox: "0 0 32 32", width: size, height: size, "aria-hidden": "true" })) node.setAttribute(key, value);
    for (const [tag, attrs] of [
      ["rect", { class: "logo-bg", x: .5, y: .5, width: 31, height: 31, rx: 7.5 }],
      ["rect", { class: "logo-tile", x: 5, y: 5, width: 10, height: 10, rx: 2.4 }],
      ["rect", { class: "logo-tile", x: 5, y: 17, width: 10, height: 10, rx: 2.4, "fill-opacity": .6 }],
      ["rect", { class: "logo-tile", x: 17, y: 17, width: 10, height: 10, rx: 2.4, "fill-opacity": .32 }],
      ["polygon", { class: "logo-plane", points: "18.2,6.2 25.8,6.2 25.8,13.8", "stroke-width": 2.4, "stroke-linejoin": "round" }],
      ["path", { class: "logo-fold", d: "M25.1 6.9 22.2 9.8", "stroke-width": 1.1, "stroke-linecap": "round" }],
    ]) {
      const child = document.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attrs)) child.setAttribute(key, value);
      node.append(child);
    }
    return node;
  }

  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (key === "className") node.className = value;
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat()) {
      if (child != null && child !== false) node.append(child instanceof Node ? child : String(child));
    }
    return node;
  }

  const iconButton = (name, title, onclick, extra = "") =>
    h("button", { type: "button", className: `icon-btn ${extra}`, title, "aria-label": title, onclick }, svg(name));

  /** 当前页面就是配置的 Tessera 站点时不显示悬浮按钮、不嗅探（Tampermonkey 菜单里的「设置」仍可用）。 */
  function onTessera() {
    try { return Boolean(settings().server) && new URL(settings().server).origin === location.origin; } catch { return false; }
  }

  let host, shadow, root, fab, badge, panel, toastTimer;
  let active = false;  // 当前网站是否启用（嗅探、悬浮按钮、站内按钮）

  function mount() {
    if (host || !document.documentElement) return;
    host = h("div", { id: "tessera-grabber" });
    host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483646;";
    shadow = host.attachShadow({ mode: "closed" });
    root = h("div", { className: "root" });
    shadow.append(h("style", {}, STYLE), root);
    badge = h("span", { className: "badge", hidden: true });
    fab = h("button", { type: "button", className: "fab", title: "Tessera 资源抓取（可拖动）", "aria-label": "Tessera 资源抓取" }, logo(26), badge);
    enableDrag(fab);
    root.append(fab);
    document.documentElement.append(host);
    placeFab();
    refreshFab();
    listeners.add(refreshFab);
    document.addEventListener("fullscreenchange", refreshFab);
    window.addEventListener("resize", () => { placeFab(); placePanel(); });
  }

  // ----- 悬浮按钮拖动 -----

  const FAB = 42, EDGE = 16;
  /** 位置保存为 { side: "left" | "right", y: 顶部占视口高度的比例 }，跨站点共用。 */
  const fabPosition = () => ({ side: "right", y: null, ...gm.get("fabPosition", {}) });

  function placeFab() {
    if (!fab) return;
    const { side, y } = fabPosition();
    const top = y == null ? innerHeight - FAB - 24 : y * innerHeight;
    fab.style.top = `${Math.min(Math.max(top, EDGE), innerHeight - FAB - EDGE)}px`;
    fab.style.left = `${side === "left" ? EDGE : innerWidth - FAB - EDGE}px`;
  }

  function enableDrag(button) {
    let start = null, moved = false;
    button.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      const rect = button.getBoundingClientRect();
      start = { x: event.clientX, y: event.clientY, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      moved = false;
      button.setPointerCapture(event.pointerId);
    });
    button.addEventListener("pointermove", event => {
      if (!start) return;
      if (!moved && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5) return;
      moved = true;
      button.classList.add("dragging");
      button.style.left = `${Math.min(Math.max(event.clientX - start.dx, 4), innerWidth - FAB - 4)}px`;
      button.style.top = `${Math.min(Math.max(event.clientY - start.dy, 4), innerHeight - FAB - 4)}px`;
      placePanel();
    });
    const finish = event => {
      if (!start) return;
      start = null;
      button.classList.remove("dragging");
      if (!moved) return;
      const rect = button.getBoundingClientRect();
      gm.set("fabPosition", { side: rect.left + FAB / 2 < innerWidth / 2 ? "left" : "right", y: rect.top / innerHeight });
      placeFab();
      setTimeout(placePanel, 210);
      // 拖动结束时浏览器可能紧接着派发 click：短时间内吞掉它，避免松手就打开面板。
      button.addEventListener("click", swallow, { once: true, capture: true });
      setTimeout(() => button.removeEventListener("click", swallow, { capture: true }), 300);
    };
    const swallow = event => { event.stopImmediatePropagation(); event.preventDefault(); };
    button.addEventListener("pointerup", finish);
    button.addEventListener("pointercancel", finish);
    button.addEventListener("click", () => toggle());
  }

  /** 面板贴着悬浮按钮所在的一侧；按钮在下半屏时向上展开，否则向下展开。 */
  function placePanel() {
    if (!panel) return;
    const fabRect = fab && fab.style.display !== "none" ? fab.getBoundingClientRect() : null;
    const left = fabRect ? fabRect.left + FAB / 2 < innerWidth / 2 : false;
    Object.assign(panel.style, { left: "", right: "", top: "", bottom: "" });
    // 手机等窄屏：面板贴底展开成底部抽屉，左右与底部避开安全区域（刘海、Home 指示条）。
    const sheet = innerWidth <= 560;
    panel.classList.toggle("is-sheet", sheet);
    if (sheet) {
      Object.assign(panel.style, { left: "0", right: "0", bottom: "0", maxHeight: `${Math.min(760, Math.round(innerHeight * 0.88))}px` });
      panel.style.setProperty("--panel-available", panel.style.maxHeight);
      return;
    }
    panel.style[left ? "left" : "right"] = "12px";
    if (!fabRect) {
      panel.style.bottom = "20px";
      panel.style.maxHeight = `${Math.min(760, innerHeight - 40)}px`;
    } else if (fabRect.top + FAB / 2 > innerHeight / 2) {
      panel.style.bottom = `${innerHeight - fabRect.top + 12}px`;
      panel.style.maxHeight = `${Math.min(760, fabRect.top - 24)}px`;
    } else {
      panel.style.top = `${fabRect.bottom + 12}px`;
      panel.style.maxHeight = `${Math.min(760, innerHeight - fabRect.bottom - 24)}px`;
    }
    panel.style.setProperty("--panel-available", panel.style.maxHeight);
  }

  /** 无菜单的管理器在非 Tessera 页面需要淡化按钮兜底。 */
  const dormantFab = () => !HAS_MENU && !onTessera();

  function refreshFab() {
    if (!fab) return;
    const count = [...items.values()].filter(item => item.type !== "image").length;
    badge.hidden = count === 0;
    fab.classList.toggle("has-items", count > 0);
    badge.textContent = count > 99 ? "99+" : String(count);
    // 正常显示：已启用且设置里打开了悬浮按钮。没有菜单命令时，未启用或关闭悬浮按钮也保留一个淡化按钮，否则无法再打开设置。
    const dormant = !(settings().fab && active) && dormantFab();
    fab.classList.toggle("is-dormant", dormant);
    fab.style.display = document.fullscreenElement || !(settings().fab && active) && !dormant ? "none" : "";
  }

  function toast(message) {
    if (!root) return;
    root.querySelector(".toast")?.remove();
    const node = h("div", { className: "toast", role: "status" }, message);
    root.append(node);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.remove(), 2200);
  }

  function copy(text, message = "已复制") {
    gm.copy(text);
    toast(message);
  }

  function close() {
    panel?.layer?.close();
    panel?.remove();
    panel = null;
    listeners.delete(renderListIfOpen);
    clearInterval(liveTimer);
    liveTimer = 0;
  }

  window.addEventListener("pointerup", () => { pointerDown = false; }, true);
  window.addEventListener("pointercancel", () => { pointerDown = false; }, true);

  // 面板快捷键（焦点在面板内、不在输入框时）：A 全选／取消全选，V 切换列表与网格，⌘／Ctrl+Enter 服务器下载已勾选的资源。
  window.addEventListener("keydown", event => {
    if (!panel || panel.layer || panel.back || event.isComposing || event.target !== host) return;
    const inner = shadow && shadow.activeElement || null;
    if (inner && /^(INPUT|TEXTAREA|SELECT)$/.test(inner.tagName)) return;
    const key = event.key.toLowerCase(), list = panel.querySelector(".list-host");
    if (!event.metaKey && !event.ctrlKey && !event.altKey && key === "a" && list && list.toggleAll) list.toggleAll();
    else if (!event.metaKey && !event.ctrlKey && !event.altKey && key === "v") { saveSettings({ view: settings().view === "grid" ? "list" : "grid" }); renderList(); }
    else if ((event.metaKey || event.ctrlKey) && key === "enter" && selected.size) startBatch([...selected], "server");
    else return;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  // ESC：有上一级时返回，主面板时关闭。只处理焦点在面板内或页面上没有焦点的情况，不打断网页输入框；全屏时交给网页。
  window.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !panel || document.fullscreenElement || event.isComposing) return;
    const focus = document.activeElement;
    if (event.target !== host && focus && focus !== document.body && focus !== document.documentElement) return;
    event.preventDefault();
    event.stopPropagation();
    if (panel.layer) return panel.layer.close();
    panel.back ? panel.back() : close();
  }, true);

  function toggle(context) {
    if (panel && !context) return close();
    open(context);
  }

  /** 面板骨架：标题栏 + 可滚动内容 + 可选的底部操作栏。 */
  function frame(title, body, { back, footer, wide = false, subtitle = "" } = {}) {
    close();
    const header = h("header", {},
      back ? iconButton("back", "返回", back, "back") : h("span", { className: "brand-mark" }, logo(26)),
      h("div", { className: "title-block" }, h("span", { className: "title" }, title), subtitle ? h("span", { className: "subtitle" }, subtitle) : null),
      back ? null : iconButton("settings", "设置", () => openSettings(() => open(currentContext))),
      iconButton("close", "关闭", close));
    panel = h("div", { className: `panel${wide ? " batch-panel" : ""}`, role: "dialog", "aria-label": title }, header, h("div", { className: "body" }, body),
      footer ? h("footer", {}, footer) : null);
    panel.back = back;
    panel.addEventListener("pointerdown", () => { pointerDown = true; });
    const activity = event => {
      if (event.isTrusted && (panel?.layer?.privateMode || panel?.dataset.view === "batch" && batch?.destination.private))
        privateTouch(panel?.dataset.view === "batch" ? batch?.config || settings() : settings());
    };
    panel.addEventListener("pointerdown", activity);
    panel.addEventListener("keydown", activity);
    root.append(panel);
    placePanel();
    return panel;
  }

  const emptyState = (name, text, loading = false) =>
    h("div", { className: `empty${loading ? " loading" : ""}` }, h("span", { className: "tile" }, svg(name, 20)), h("span", {}, text));

  // ----- 主面板 -----

  let filter = "all";
  let currentContext = null;
  let liveTimer = 0;
  let pointerDown = false;  // 按住鼠标期间不改动列表，避免点击落空
  const rowCache = new Map();
  const selected = new Set();  // 已勾选的资源地址，跨筛选保留

  /** context: { platform, label, url, scope } —— scope 为 X 帖子元素时只列出这条帖子的图片。 */
  function open(context) {
    mount();
    currentContext = context || platformOf(location.href);
    frame("Tessera", [
      h("div", { className: "banner-host" }),
      currentContext ? platformCard(currentContext) : null,
      cloudOf() ? cloudCard(cloudOf()) : null,
      h("div", { className: "section list-host" }),
    ], { footer: [], subtitle: "资源抓取" });
    panel.dataset.view = "main";
    renderBanner();
    renderList();
    listeners.add(renderListIfOpen);
    // 懒加载的图片和换页后的 DOM 不会触发网络嗅探，打开期间定时重新扫描，有变化才更新。
    clearInterval(liveTimer);
    liveTimer = setInterval(() => { if (panel && panel.dataset.view === "main") renderList(); }, 1500);
  }

  /** 底部栏：有勾选时显示批量操作，否则显示当前网站与「在此网站隐藏」。 */
  function renderFooter() {
    const footer = panel && panel.dataset.view === "main" && panel.querySelector("footer");
    if (!footer) return;
    if (selected.size) {
      const canUpload = collect().filter(item => selected.has(item.url)).every(browserEligible);
      footer.hidden = false;
      footer.replaceChildren(
        h("span", { className: "selection" }, `已选 ${selected.size} 项`),
        h("button", { type: "button", className: "text-btn", onclick: () => { selected.clear(); renderList(); } }, "清除"),
        h("span", { className: "spacer" }),
        h("div", { className: "footer-actions" }, h("button", { type: "button", className: "btn", disabled: !canUpload,
          title: canUpload ? "当前浏览器下载后上传到 Tessera" : "流媒体列表请使用服务器下载",
          onclick: () => startBatch([...selected], "local") }, svg("download"), `本地下载 ${selected.size} 项`),
        h("button", { type: "button", className: "btn primary", title: "由 Tessera 服务器下载",
          onclick: () => startBatch([...selected], "server") }, svg("send"), `服务器下载 ${selected.size} 项`)));
      return;
    }
    footer.hidden = onTessera();
    footer.replaceChildren(
      h("span", { className: "site", title: location.hostname }, svg("globe", 14), h("span", {}, currentSite())),
      h("span", { className: "spacer" }),
      h("button", { type: "button", className: "text-btn", title: "把这个页面的图片结构交给 Tessera 文件助手分析",
        onclick: () => openAssistant() }, "发给文件助手"),
      h("button", { type: "button", className: "text-btn", onclick: () => setSiteEnabled(!active) }, active ? "在此网站隐藏" : "在此网站启用"));
  }

  function platformCard(context) {
    const youtube = context.platform === "youtube";
    return h("div", { className: "hero" },
      h("div", { className: "hero-head" },
        h("span", { className: "hero-mark" }, svg(youtube ? "youtube" : "x", 18)),
        h("div", { className: "hero-text" }, h("strong", {}, context.label), h("div", { className: "sub" }, context.url))),
      h("div", { className: "actions" },
        h("button", { type: "button", className: "btn primary block", onclick: () => startBatch([{ url: context.url, platform: context.platform }], "server") }, svg("send"), "服务器下载"),
        iconButton("link", "复制链接", () => copy(context.url, "已复制链接")),
        iconButton("terminal", "复制 curl 命令", async () => copy(await curlFor(context.url), "已复制 curl 命令"))),
      h("p", { className: "hint" }, youtube
        ? "YouTube 的媒体地址带签名且分段，无法直接下载；发送后由服务器解析并选择清晰度。"
        : "视频由服务器解析；图片可以在下方直接复制原图地址。"));
  }

  function cloudCard(context) {
    const guide = cloudShareGuide(context);
    return h("div", { className: "hero" },
      h("div", { className: "hero-head" }, h("span", { className: "hero-mark" }, svg("folder", 18)),
        h("div", { className: "hero-text" }, h("strong", {}, context.label), h("div", { className: "sub" }, guide ? "分享文件需先转存" : "获取网盘中已勾选的文件"))),
      h("div", { className: "actions" },
        guide ? h("button", { type: "button", className: "btn primary block", onclick: () => gm.openTab(guide.url) }, svg("external"), "打开我的网盘")
          : h("button", { type: "button", className: "btn primary block", onclick: async event => {
            const button = event.currentTarget, opened = panel;
            button.disabled = true;
            try {
              const sources = await cloudSources(cloudOf() || context);
              if (panel === opened) startBatch(sources, "server");
            } catch (error) { if (!error.silent) toast(error.message); }
            finally { button.disabled = false; }
          } }, svg("send"), "发送已选网盘文件"),
        context.provider === "baidu" && !context.share ? h("button", { type: "button", className: "btn", onclick: authorizeCloudBaidu }, "授权百度取链") : null),
      h("p", { className: "hint" }, guide?.hint || (cloudFolderLister(context)
        ? "先在网盘中勾选文件或文件夹，再确认保存位置和文件名。勾选文件夹时会列出其中的文件供挑选，并按原目录结构保存。"
        : "先在网盘中勾选文件，再确认保存位置和文件名。文件夹请打开后选择里面的文件。")),
      context.provider === "baidu" && !context.share ? h("p", { className: "hint" }, "首次使用需在百度页面确认取链授权，完成后回到这里重试。") : null);
  }

  // X、YouTube 会持续加载资源：新资源到达时最多每秒刷新一次列表。
  let renderTimer = 0;
  function renderListIfOpen() {
    if (!panel || renderTimer) return;
    renderTimer = setTimeout(() => { renderTimer = 0; if (panel) renderList(); }, 1000);
  }

  function collect() {
    const scope = currentContext && currentContext.scope;
    if (!scope) scanFrameDom();
    const dom = scanDom(scope || document);
    if (scope) { for (const item of dom) noteMeta(item.url, 0, item.dims); return dom.filter(item => !clearedUrls.has(item.url)); } // 单条帖子只看它自己的媒体
    // DOM 中扫描到的资源也记下来：之后它们离开页面（关闭弹窗、切换标签）仍然留在列表里。
    for (const item of dom) remember(item.url, item.type, { source: item.source, dims: item.dims });
    const merged = new Map();
    for (const item of [...items.values()].reverse()) merged.set(item.url, item);
    if (currentContext && currentContext.platform === "youtube") {
      const cover = `https://i.ytimg.com/vi/${currentContext.id}/maxresdefault.jpg`;
      merged.set(cover, { url: cover, type: "image", source: "封面" });
    }
    return [...merged.values()].filter(item => !clearedUrls.has(item.url));
  }

  function clearResources() {
    for (const item of collect()) clearedUrls.add(item.url);
    items.clear();
    selected.clear();
    rowCache.clear();
    filter = "all";
    refreshFab();
    renderList();
    toast("已清空探测记录");
  }

  /** 让 parent 的子节点依次等于 nodes：已在正确位置的节点不移动，新节点插入，多余的移除。 */
  function syncChildren(parent, nodes) {
    nodes.forEach((node, index) => { if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] || null); });
    while (parent.children.length > nodes.length) parent.lastElementChild.remove();
  }

  /**
   * 列表原地更新：首次创建骨架，之后只改计数、勾选状态并按地址复用行元素。
   * 定时刷新和新资源到达都会调用这里，整块替换会让正在进行的点击落空、滚动位置跳动。
   */
  function renderList() {
    const target = panel && panel.querySelector(".list-host");
    if (!target || pointerDown) return;
    const all = collect();
    const sent = new Set(sentList());
    const urls = new Set(all.map(item => item.url));
    for (const url of selected) if (!urls.has(url)) selected.delete(url);
    for (const url of rowCache.keys()) if (!urls.has(url)) rowCache.delete(url);
    const counts = all.reduce((acc, item) => ({ ...acc, [item.type]: (acc[item.type] || 0) + 1 }), {});
    const types = Object.keys(TYPE_LABEL).filter(type => counts[type]);
    if (filter !== "all" && !counts[filter]) filter = "all";
    const hideSmall = settings().hideSmall !== false;
    const isSmall = item => { const dims = item.type === "image" && (resourceMeta.get(item.url) || {}).dims; return Boolean(dims && (dims[0] < SMALL_IMAGE || dims[1] < SMALL_IMAGE)); };
    const typed = all.filter(item => filter === "all" || item.type === filter);
    const small = typed.filter(isSmall).length;
    // 已勾选的小图仍然显示，避免隐藏后看不到却被一起发送。
    const shown = hideSmall ? typed.filter(item => !isSmall(item) || selected.has(item.url)) : typed;
    // 全选只作用于当前筛选下显示、且尚未发送过的资源。
    const pickable = shown.filter(item => !sent.has(item.url));
    const picked = pickable.filter(item => selected.has(item.url)).length;
    const allPicked = pickable.length > 0 && picked === pickable.length;

    if (!target.parts) {
      const parts = {
        check: h("span", { className: "check" }),
        count: h("span", { className: "count" }),
        clear: h("button", { type: "button", className: "text-btn", onclick: clearResources }, "清空"),
        view: h("button", { type: "button", className: "icon-btn view-toggle", onclick: () => { saveSettings({ view: settings().view === "grid" ? "list" : "grid" }); renderList(); } }),
        chips: h("div", { className: "chips" }),
        list: h("div", { className: "list" }),
        empty: emptyState("search", "还没有发现可下载的资源。播放视频或滚动加载图片后再打开。"),
      };
      parts.selectAll = h("span", { className: "select-all", role: "checkbox", tabindex: "0", onclick: () => target.toggleAll(),
        onkeydown: event => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); target.toggleAll(); } } }, parts.check);
      target.replaceChildren(
        h("div", { className: "section-head" }, parts.selectAll, h("h2", {}, "页面资源", parts.count), h("span", { className: "spacer" }), parts.clear, parts.view),
        parts.chips, parts.list, parts.empty);
      target.parts = parts;
    }
    const parts = target.parts;
    target.toggleAll = () => {
      if (allPicked) pickable.forEach(item => selected.delete(item.url));
      else {
        // 勾选数量不设上限，发送时按设置的每批文件数（batchLimit）自动分批，与网盘文件一致。
        for (const item of pickable) selected.add(item.url);
      }
      renderList();
    };
    parts.count.textContent = String(all.length);
    // 网格视图：同一批行元素换成缩略图卡片（纯样式切换，不重建节点）。
    const grid = settings().view === "grid";
    if (parts.view.dataset.grid !== String(grid)) {
      parts.view.dataset.grid = String(grid);
      parts.view.replaceChildren(svg(grid ? "rows" : "grid"));
      parts.view.title = grid ? "列表视图" : "网格视图";
      parts.view.setAttribute("aria-label", parts.view.title);
      parts.list.classList.toggle("grid", grid);
    }
    parts.view.hidden = !all.length;
    parts.clear.hidden = !all.length || Boolean(currentContext && currentContext.scope);
    parts.selectAll.hidden = !pickable.length;
    parts.selectAll.title = allPicked ? "取消全选" : sent.size && shown.length > pickable.length ? "全选（跳过已发送）" : "全选";
    parts.selectAll.setAttribute("aria-checked", allPicked ? "true" : picked ? "mixed" : "false");
    parts.check.className = `check${picked ? " on" : ""}`;
    parts.check.replaceChildren(svg(allPicked ? "check" : "minus", 12, 3));
    // 筛选标签只在种类或数量变化时重建。
    const chipKey = types.length > 1 || small ? `${filter}|${types.map(type => `${type}:${counts[type]}`).join(",")}|${small}|${hideSmall}` : "";
    if (parts.chips.dataset.key !== chipKey) {
      parts.chips.dataset.key = chipKey;
      const chip = (value, label) => h("button", { type: "button", className: "chip", "aria-pressed": String(filter === value),
        onclick: () => { filter = value; renderList(); } }, label);
      const smallChip = small ? [h("button", { type: "button", className: "chip chip-toggle", "aria-pressed": String(!hideSmall),
        title: `宽或高小于 ${SMALL_IMAGE} 像素的图片（多是图标、头像）`,
        onclick: () => { saveSettings({ hideSmall: !hideSmall }); renderList(); } }, hideSmall ? `显示 ${small} 张小图` : "隐藏小图")] : [];
      parts.chips.replaceChildren(...(types.length > 1 ? [chip("all", "全部"), ...types.map(type => chip(type, `${TYPE_LABEL[type]} ${counts[type]}`))] : []), ...smallChip);
    }
    parts.chips.hidden = !chipKey;
    syncChildren(parts.list, shown.map(item => {
      let node = rowCache.get(item.url);
      if (!node) rowCache.set(item.url, node = row(item));
      syncRow(node, item, sent.has(item.url));
      return node;
    }));
    parts.list.hidden = !shown.length;
    parts.empty.hidden = Boolean(shown.length);
    renderFooter();
  }

  function row(item) {
    const tile = h("span", { className: "tile" }, item.type === "image"
      ? h("img", { src: item.url, alt: "", loading: "lazy", referrerpolicy: "no-referrer",
        onload: event => noteMeta(item.url, 0, [event.currentTarget.naturalWidth, event.currentTarget.naturalHeight]) }) : svg(TYPE_ICON[item.type], 18));
    // 勾选状态在点击时读取，行元素会被复用。
    const toggle = () => {
      if (selected.has(item.url)) selected.delete(item.url);
      else selected.add(item.url);
      renderList();
    };
    const node = h("div", { className: "item selectable", role: "checkbox", tabindex: "0",
      // 点击行的空白处切换勾选；行尾的按钮各自处理，不触发勾选。
      onclick: event => { if (!event.target.closest("button")) toggle(); },
      onkeydown: event => { if ((event.key === " " || event.key === "Enter") && event.target === event.currentTarget) { event.preventDefault(); toggle(); } } },
      h("span", { className: "check" }, svg("check", 12, 3)),
      tile,
      h("div", { className: "meta" },
        h("div", { className: "name", title: item.url }, fileName(item.url)),
        h("div", { className: "sub" }, h("span", { className: "sent-tag" }, "已发送"), h("span", { className: "sub-text" }, describe(item)))),
      h("div", { className: "item-actions" },
        // 次要操作在桌面悬停或键盘聚焦时浮现，不占用文件名的宽度；触屏设备始终显示。
        h("span", { className: "secondary" },
          iconButton("link", "复制链接", () => copy(item.url, "已复制链接")),
          iconButton("terminal", "复制 curl 命令", async () => copy(await curlFor(item.url), "已复制 curl 命令")),
          iconButton("external", "在新标签页打开", () => gm.openTab(item.url)),
          h("span", { className: "action-sep", "aria-hidden": "true" })),
        browserEligible(item) ? iconButton("download", "本地下载（当前浏览器下载后上传）", () => startBatch([item.url], "local"), "local-btn")
          : h("button", { type: "button", className: "icon-btn local-btn", disabled: true, title: "流媒体列表请使用服务器下载", "aria-label": "本地下载不可用" }, svg("download")),
        // 窄屏（底部抽屉）只留「更多」和服务器下载，其余操作收进面板内的操作菜单，行保持一行高。
        iconButton("more", "更多操作", () => openRowActions(item), "more-btn"),
        iconButton("send", "服务器下载", () => startBatch([item.url], "server"), "accent")));
    node.dataset.url = item.url;
    watchSize(node, item);
    return node;
  }

  function openRowActions(item) {
    const local = browserEligible(item);
    openActionSheet(fileName(item.url), describe(item), [
      { icon: "link", label: "复制链接", run: () => copy(item.url, "已复制链接") },
      { icon: "terminal", label: "复制 curl 命令", run: async () => copy(await curlFor(item.url), "已复制 curl 命令") },
      { icon: "external", label: "在新标签页打开", run: () => gm.openTab(item.url) },
      { icon: "download", label: "本地下载", hint: local ? "当前浏览器下载后上传" : "流媒体列表请使用服务器下载", disabled: !local, run: () => startBatch([item.url], "local") },
      { icon: "send", label: "服务器下载", accent: true, run: () => startBatch([item.url], "server") },
    ]);
  }

  /** 面板内的操作菜单：从面板底部升起，点空白处、取消或 Esc 关闭（经 panel.layer），不替换面板内容。 */
  function openActionSheet(title, subtitle, actions) {
    if (!panel) return;
    panel.layer?.close();
    const host = panel, opener = shadow.activeElement;
    const closeSheet = () => {
      sheet.remove();
      if (panel && panel.layer === controller) panel.layer = null;
      if (opener?.isConnected) opener.focus();
    };
    const controller = { close: closeSheet };
    const sheet = h("div", { className: "action-sheet", onclick: event => { if (event.target === event.currentTarget) closeSheet(); } },
      h("div", { className: "action-card", role: "menu", "aria-label": title },
        h("div", { className: "action-head" }, h("strong", { title }, title), subtitle ? h("span", {}, subtitle) : null),
        actions.map(action => h("button", { type: "button", role: "menuitem", className: `action-item${action.accent ? " accent" : ""}`, disabled: action.disabled,
          onclick: () => { host.layer = null; sheet.remove(); action.run(); } },
          svg(action.icon, 18), h("span", { className: "action-label" }, action.label, action.hint ? h("small", {}, action.hint) : null))),
        h("button", { type: "button", className: "action-cancel", onclick: closeSheet }, "取消")));
    panel.layer = controller;
    host.append(sheet);
    sheet.querySelector(".action-item:not(:disabled)")?.focus({ preventScroll: true });
  }

  // ---------- 资源大小探测 ----------
  // 行进入可见区域后才探测，最多同时 3 个：先 HEAD 读 Content-Length；没有时用 GET Range: bytes=0-0 读 Content-Range，
  // 收到响应头即中止。结果按地址缓存，失败（验证页、403、超时）不再重试；M3U8 只是播放列表，不探测。
  const PROBE_LIMIT = 3;
  const probeQueue = [];
  const probed = new Set();
  let probing = 0, sizeObserver = null;
  function describe(item) {
    let domain = "";
    try { domain = new URL(item.url).hostname.replace(/^www\./, ""); } catch { /* 忽略 */ }
    const meta = resourceMeta.get(item.url) || {};
    return [TYPE_LABEL[item.type], item.type === "stream" ? "播放列表" : meta.size ? formatSize(meta.size) : "",
      meta.dims ? `${meta.dims[0]}×${meta.dims[1]}` : "", domain, item.frame ? "iframe" : ""].filter(Boolean).join(" · ");
  }
  function syncMeta(url) {
    const node = rowCache.get(url), item = node && (items.get(url) || { url, type: node.dataset.type });
    const text = node?.querySelector(".sub-text");
    if (text && item.type) { const value = describe(item); if (text.textContent !== value) text.textContent = value; }
  }
  function watchSize(node, item) {
    node.dataset.type = item.type;
    if (typeof IntersectionObserver !== "function") return wantSize(item);
    sizeObserver ??= new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        sizeObserver.unobserve(entry.target);
        wantSize({ url: entry.target.dataset.url, type: entry.target.dataset.type });
      }
    });
    sizeObserver.observe(node);
  }
  function wantSize(item) {
    if (item.type === "stream" || resourceMeta.get(item.url)?.size || probed.has(item.url)) return;
    probed.add(item.url);
    probeQueue.push(item.url);
    pumpProbes();
  }
  function pumpProbes() {
    while (probing < PROBE_LIMIT && probeQueue.length) {
      const url = probeQueue.shift();
      probing += 1;
      requestSize(url).then(size => noteMeta(url, size)).finally(() => { probing -= 1; pumpProbes(); });
    }
  }
  async function requestSize(url) {
    return await probeSize(url, "HEAD") || await probeSize(url, "GET", { Range: "bytes=0-0" });
  }
  function probeSize(url, method, headers) {
    return new Promise(resolve => {
      let request = null, done = false;
      const finish = size => { if (done) return; done = true; clearTimeout(timer); resolve(size || 0); };
      const timer = setTimeout(() => { finish(0); request?.abort(); }, 15000);
      const read = response => {
        if (done || !response?.status || (response.readyState ?? 4) < 2) return false;
        const headersText = response.responseHeaders;
        const total = response.status >= 400 || isChallenge(response.status, headersText) ? 0
          : Number(sourceHeader(headersText, "content-range").match(/\/(\d+)\s*$/)?.[1])
            || (method === "HEAD" || response.status === 200 ? Number(sourceHeader(headersText, "content-length")) : 0);
        finish(total);
        if (method !== "HEAD") request?.abort();
        return true;
      };
      try {
        request = gm.xhr({ method, url, headers, timeout: 15000, onreadystatechange: read,
          onload: response => { if (!read({ ...response, readyState: 4 })) finish(0); },
          onerror: () => finish(0), ontimeout: () => finish(0), onabort: () => finish(0) });
      } catch { finish(0); }
    });
  }

  function syncRow(node, item, sent) {
    const on = selected.has(item.url);
    node.classList.toggle("is-selected", on);
    node.classList.toggle("is-sent", sent);
    node.setAttribute("aria-checked", String(on));
    node.querySelector(".check").classList.toggle("on", on);
    node.querySelector(".sent-tag").hidden = !sent;
  }

  function formatSize(size) {
    if (!size) return "大小未知";
    const units = ["B", "KB", "MB", "GB"];
    let value = size, index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
    return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
  }

  // ----- 保存位置 -----

  const savedDestination = () => ({ path: settings().destination || "", private: Boolean(settings().destinationPrivate) });
  const rememberDestination = dest => saveSettings({ destination: dest.path, destinationPrivate: dest.private });
  const destinationLabel = dest => dest.private ? `私密空间${dest.path && privateCurrent(settings()) ? ` / ${dest.path.replace(/\/$/, "")}` : ""}` : dest.path ? dest.path.replace(/\/$/, "") : "根目录";
  const destinationSub = dest => dest.private ? privateCurrent(settings()) ? "私密空间已解锁" : "私密空间 · 发送前解锁" : "保存位置";

  /** 保存位置摘要行；点击「更改」在当前面板上打开目录选择层。get/set 由调用方保存状态。 */
  function destinationRow(get, set, allowPrivate = true) {
    const name = h("div", { className: "name" }), sub = h("div", { className: "label" }), tile = h("span", { className: "tile" });
    const row = h("div", { className: "dest" }, tile, h("div", { className: "meta" }, sub, name),
      h("button", { type: "button", className: "btn ghost", onclick: () => openPicker(get(), dest => { set(dest); update(); }, allowPrivate) }, "更改"));
    function update() {
      const dest = get();
      row.className = `dest${dest.private ? " private" : ""}`;
      tile.replaceChildren(svg(dest.private ? "lock" : "folder", 18));
      name.textContent = destinationLabel(dest);
      name.title = name.textContent;
      sub.textContent = destinationSub(dest);
    }
    update();
    const refresh = () => { if (row.isConnected === false) privateViews.delete(refresh); else update(); };
    privateViews.add(refresh);
    return row;
  }

  /** 目录选择层：逐级浏览（GET /api/v1/folders）、新建文件夹（POST /api/v1/folders）或选择私密空间。 */
  function openPicker(initial, onPick, allowPrivate = true) {
    if (!panel) return;
    panel.layer?.close();
    let mode = initial.private && allowPrivate ? "private" : "files";
    let prefix = initial.path || "";
    let state = { folders: [], next: null, writable: true, loading: true, error: "" };
    let request = 0, unlocking = false;
    const body = h("div", { className: "body" });
    const footer = h("footer", {});
    const layer = h("div", { className: "layer", role: "dialog", "aria-label": "选择保存位置" },
      h("header", {}, iconButton("back", "返回", () => closeLayer(), "back"), h("span", { className: "title" }, "选择保存位置")), body, footer);
    const host = panel;
    const closeLayer = () => {
      privateViews.delete(privateChanged);
      layer.remove();
      host.classList.remove("has-layer");
      if (panel && panel.layer === controller) panel.layer = null;
    };
    const controller = { close: closeLayer, get privateMode() { return mode === "private"; } };
    const privateChanged = () => {
      if (layer.isConnected === false) return privateViews.delete(privateChanged);
      if (mode === "private" && !privateCurrent(settings())) {
        if (unlocking) return;
        request++; state = { folders: [], next: null, writable: false, loading: false, error: "私密空间已锁定，请重新解锁" };
        render();
      }
    };
    privateViews.add(privateChanged);
    panel.layer = controller;
    host.classList.add("has-layer");
    panel.append(layer);

    async function load(more = false) {
      const id = ++request;
      if (!more) state = { folders: [], next: null, writable: true, loading: true, error: "" };
      else state.loading = true;
      render();
      try {
        const privateSpace = mode === "private";
        if (privateSpace) {
          unlocking = true;
          try { await ensurePrivate(); } finally { unlocking = false; }
        }
        if (id !== request) return;
        const query = `prefix=${encodeURIComponent(prefix)}&limit=100${more && state.next ? `&cursor=${encodeURIComponent(state.next)}` : ""}`;
        const page = await api("GET", `/api/v1/folders?${query}`, undefined, { privateSpace });
        if (id !== request) return;
        state = { folders: more ? state.folders.concat(page.folders) : page.folders, next: page.next_cursor, writable: page.writable, loading: false, error: "" };
      } catch (error) {
        if (id !== request) return;
        state = { ...state, loading: false, error: error.message };
      }
      render();
    }
    const enter = path => { prefix = path; void load(); };

    function render() {
      const seg = (value, label) => h("button", { type: "button", role: "radio", "aria-checked": String(mode === value),
        disabled: value === "private" && !allowPrivate,
        onclick: () => {
          if (mode === value) return;
          mode = value;
          prefix = "";
          // 从私密空间打开时还没读取过目录：第一次切到「我的文件」才发请求。
          void load();
        } }, label);
      const parts = [h("div", { className: "segmented", role: "radiogroup", "aria-label": "目标空间" }, seg("files", "我的文件"), seg("private", "私密空间"))];
      if (mode === "private" && !privateCurrent(settings())) {
        parts.push(h("div", { className: "private-note" },
          h("strong", {}, state.loading ? "正在解锁私密空间…" : "私密空间已锁定"),
          h("span", {}, state.error || "在面板内用账号登录密码解锁；支持的浏览器也可使用通行密钥。解锁后直接选择目录、下载或上传。"),
          h("button", { type: "button", className: "btn primary", disabled: state.loading, onclick: () => void load() }, "解锁私密空间")));
        footer.replaceChildren(h("span", { className: "spacer" }), h("button", { type: "button", className: "btn ghost", onclick: closeLayer }, "取消"),
          h("span", { className: "hint" }, "密码只在 Tessera 来源的安全页面中输入"));
        body.replaceChildren(...parts);
        return;
      }
      if (mode === "private") parts.push(h("div", { className: "private-note" },
        h("strong", {}, "私密空间已解锁"), h("span", {}, `有私密操作时续期，闲置 ${(privateCurrent(settings())?.idle_seconds || 1800) / 60} 分钟自动锁定`),
        h("button", { type: "button", className: "btn ghost", onclick: () => void privateLock().catch(error => toast(error.message)) }, "立即锁定")));
      const segments = prefix.split("/").filter(Boolean);
      const crumbs = [h("button", { type: "button", onclick: () => enter(""), ...(segments.length ? {} : { "aria-current": "page" }) }, mode === "private" ? "私密空间" : "根目录")];
      segments.forEach((segment, index) => {
        const path = segments.slice(0, index + 1).join("/") + "/";
        crumbs.push(svg("chevron", 12), h("button", { type: "button", onclick: () => enter(path), ...(index === segments.length - 1 ? { "aria-current": "page" } : {}) }, segment));
      });
      parts.push(h("nav", { className: "crumbs", "aria-label": "当前位置" }, crumbs));
      if (state.error) parts.push(h("div", { className: "error" }, state.error));
      if (state.folders.length) {
        parts.push(h("div", { className: "list" }, state.folders.map(folder => h("button", { type: "button", className: "folder-row", onclick: () => enter(folder) },
          svg("folder", 18), h("span", { className: "name", title: folder }, folder.slice(prefix.length).replace(/\/$/, "")), svg("chevron", 14)))));
        if (state.next) parts.push(h("button", { type: "button", className: "text-btn", disabled: state.loading, onclick: () => void load(true) }, state.loading ? "加载中…" : "加载更多"));
      } else if (state.loading) parts.push(emptyState("loader", "正在读取文件夹…", true));
      else if (!state.error) parts.push(h("p", { className: "hint" }, "这里没有子文件夹。"));
      // 新建文件夹：建在当前目录下并直接进入。
      const input = h("input", { type: "text", placeholder: "新文件夹名称", maxLength: 255,
        onkeydown: event => { if (event.key === "Enter") { event.preventDefault(); void create(); } } });
      const createButton = h("button", { type: "button", className: "btn", disabled: !state.writable }, svg("folderPlus"), "新建");
      async function create() {
        const name = input.value.trim();
        if (!name) return input.focus();
        if (/[\\/]/.test(name) || name === "." || name === ".." || name.startsWith(".tgdrive")) return toast("文件夹名称不能包含 / 或 \\");
        createButton.disabled = true;
        try { await api("POST", "/api/v1/folders", { path: prefix + name + "/" }, { privateSpace: mode === "private" }); enter(prefix + name + "/"); }
        catch (error) { toast(error.message); createButton.disabled = false; }
      }
      createButton.addEventListener("click", () => void create());
      if (state.writable) parts.push(h("div", { className: "new-folder" }, input, createButton));
      else if (!state.loading) parts.push(h("p", { className: "hint" }, "这个访问密钥不能写入当前目录，请进入有读写权限的文件夹。"));
      footer.replaceChildren(h("span", { className: "spacer" }), h("button", { type: "button", className: "btn ghost", onclick: closeLayer }, "取消"),
        h("button", { type: "button", className: "btn primary", disabled: !state.writable || state.loading && !state.folders.length,
          onclick: () => { closeLayer(); onPick({ path: prefix, private: mode === "private" }); } }, `保存到「${destinationLabel({ path: prefix, private: mode === "private" })}」`));
      body.replaceChildren(...parts);
    }
    void load();
  }

  // ----- 发给文件助手（docs/assistant-design.md §9.1） -----

  /**
   * 页面结构快照：与服务端解析 HTML 得到的「规范页」相同（web.py）。图片按元素路径（最近 4 层「标签.首个类名」，数字替换为 *）
   * 聚类，记录 src（currentSrc）、data-* 懒加载地址、srcset 最大项与外层链接；链接只保留像「下一页」或页码的那些。不含正文。
   */
  const ASSISTANT_MAX_PAGES = 50, ASSISTANT_MAX_IMAGES = 5000, ASSISTANT_MAX_BYTES = 2 * 1024 * 1024, ASSISTANT_TTL = 86400000;
  const NEXT_TEXT = /^\s*(下一页|下页|后页|下一张|next(\s*page)?|older|more|›|»|>|→)\s*[›»>→]?\s*$/i;
  const LAZY_ATTRS = ["data-src", "data-original", "data-lazy-src", "data-lazy", "data-url"];

  function segmentOf(node) {
    const tag = node.tagName.toLowerCase();
    const first = (node.getAttribute("class") || "").split(/\s+/).find(Boolean) || "";
    const cls = first.replace(/[^A-Za-z0-9_-]/g, "").replace(/\d+/g, "*").slice(0, 30);
    return cls ? `${tag}.${cls}` : tag;
  }
  function pathOf(node) {
    const chain = [];
    for (let current = node; current && current.nodeType === 1 && chain.length < 4; current = current.parentElement) {
      if (current.tagName.toLowerCase() === "html") break;
      chain.unshift(segmentOf(current));
    }
    return chain.join(">");
  }
  function absolute(value, base) {
    if (!value) return null;
    try {
      const url = new URL(value.trim(), base);
      return /^https?:$/.test(url.protocol) && url.href.length <= 2048 ? url.href.split("#")[0] : null;
    } catch { return null; }
  }
  function largestSrcset(value) {
    let best = null, size = -1;
    for (const part of (value || "").split(",")) {
      const [url, descriptor] = part.trim().split(/\s+/);
      if (!url) continue;
      const match = /^([\d.]+)([wx])$/.exec(descriptor || "");
      const current = match ? parseFloat(match[1]) * (match[2] === "w" ? 1 : 1000) : 1;
      if (current > size) { best = url; size = current; }
    }
    return best;
  }
  function pageSnapshot(doc = document, url = location.href) {
    const images = [];
    for (const img of [...(doc.images || [])].slice(0, 2000)) {
      if (host && host.contains && host.contains(img)) continue;
      const width = img.naturalWidth || Number(img.getAttribute("width")) || null;
      const height = img.naturalHeight || Number(img.getAttribute("height")) || null;
      if (width && height && width < 32 && height < 32) continue;
      const urls = {};
      const src = absolute(img.currentSrc || img.getAttribute("src"), url);
      if (src) urls.src = src;
      for (const name of LAZY_ATTRS) { const value = absolute(img.getAttribute(name), url); if (value) urls[name] = value; }
      const srcset = absolute(largestSrcset(img.getAttribute("srcset") || img.getAttribute("data-srcset")), url);
      if (srcset) urls.srcset = srcset;
      const anchor = img.closest && img.closest("a[href]");
      const href = anchor && absolute(anchor.getAttribute("href"), url);
      if (href) urls.href = href;
      if (Object.keys(urls).length) images.push({ path: pathOf(img), urls, w: width, h: height });
    }
    const links = [];
    for (const anchor of [...doc.querySelectorAll("a[href], link[rel~=next]")]) {
      const text = (anchor.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
      const rel = (anchor.getAttribute("rel") || "").toLowerCase();
      if (!rel.split(/\s+/).includes("next") && !NEXT_TEXT.test(text) && !/^\d{1,4}$/.test(text)) continue;
      const href = absolute(anchor.getAttribute("href"), url);
      if (href) links.push({ path: pathOf(anchor), href, text, rel });
      if (links.length >= 60) break;
    }
    return { url: absolute(url, url) || url, title: (doc.title || "").replace(/\s+/g, " ").trim().slice(0, 200), images, links };
  }

  /** 多页暂存（GM_setValue "assistant-pages"）：同一来源最多 50 页、5,000 个图片候选、2 MB，24 小时过期。 */
  function assistantPages(origin = location.origin) {
    const stored = gm.get("assistant-pages", null);
    if (!stored || stored.origin !== origin || Date.now() - stored.savedAt > ASSISTANT_TTL) return [];
    return Array.isArray(stored.pages) ? stored.pages : [];
  }
  function addAssistantPage(snapshot, origin = location.origin) {
    const pages = assistantPages(origin).filter(page => page.url !== snapshot.url);
    const next = [...pages, snapshot];
    const images = next.reduce((sum, page) => sum + page.images.length, 0);
    if (next.length > ASSISTANT_MAX_PAGES) throw new Error(`最多暂存 ${ASSISTANT_MAX_PAGES} 页，请先发送`);
    if (images > ASSISTANT_MAX_IMAGES) throw new Error(`图片候选超过 ${ASSISTANT_MAX_IMAGES} 个，请先发送已暂存的页面`);
    if (new TextEncoder().encode(JSON.stringify(next)).length > ASSISTANT_MAX_BYTES) throw new Error("暂存的快照超过 2 MB，请先发送");
    gm.set("assistant-pages", { origin, savedAt: Date.now(), pages: next });
    return next;
  }
  const clearAssistantPages = () => gm.set("assistant-pages", null);

  /**
   * 打开 Tessera 页面并转交快照：必须在点击事件里同步 window.open；页面报到后 postMessage 发送，收到确认后清空暂存。
   * 协议与 web/src/user/page-import.ts 一致，只认 Tessera 的 origin 与本次的随机 nonce。
   */
  function sendAssistantPages(server, pages) {
    const origin = new URL(server).origin;
    const nonce = [...crypto.getRandomValues(new Uint8Array(18))].map(value => value.toString(16).padStart(2, "0")).join("");
    const tab = page.open(`${origin}/?view=files#assistant-page=${nonce}&from=${encodeURIComponent(location.origin)}`, "_blank");
    if (!tab) throw new Error("浏览器拦截了新标签页，请允许当前网站打开弹出窗口后重试");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { finish(); reject(new Error("Tessera 页面没有响应：请确认已在新标签页登录 Tessera；部分网站禁止跨站窗口通信")); }, 300000);
      const finish = () => { clearTimeout(timer); window.removeEventListener("message", onMessage); };
      const onMessage = event => {
        const data = event.data;
        if (event.origin !== origin || !data || data.source !== "tessera" || data.nonce !== nonce) return;
        if (data.type === "page-ready") tab.postMessage({ source: "tessera-grabber", nonce, type: "page-snapshot", pages }, origin);
        if (data.type === "page-ack") { finish(); if (data.ok) resolve(); else reject(new Error(data.error || "Tessera 页面拒收了快照")); }
      };
      window.addEventListener("message", onMessage);
    });
  }

  let scrolling = null;
  /** 先滚动到底部：触发懒加载，最多 30 秒或 200 屏，连续 3 次高度不变即停止；可随时停止。 */
  function autoScroll(onDone) {
    const started = Date.now();
    let screens = 0, stable = 0, height = 0;
    const step = () => {
      const current = document.documentElement.scrollHeight;
      stable = current === height ? stable + 1 : 0;
      height = current;
      if (stable >= 3 || screens >= 200 || Date.now() - started > 30000 || !scrolling) { stopScroll(); onDone(); return; }
      window.scrollBy(0, innerHeight * .9);
      screens += 1;
      scrolling = setTimeout(step, 450);
    };
    scrolling = setTimeout(step, 0);
  }
  const stopScroll = () => { clearTimeout(scrolling); scrolling = null; };

  function openAssistant() {
    mount();
    const server = settings().server;
    const status = h("div", { className: "status", hidden: true });
    const summary = h("div", { className: "hint" });
    const scrollButton = h("button", { type: "button", className: "btn" });
    const addButton = h("button", { type: "button", className: "btn" }, svg("folderPlus"), "加入本页并继续");
    const sendButton = h("button", { type: "button", className: "btn primary" });
    const show = (text, error = false) => { status.hidden = false; status.className = `status${error ? " error" : ""}`; status.textContent = text; };
    const refresh = () => {
      const pages = assistantPages();
      const here = pages.some(page => page.url === location.href);
      const total = pages.length + (here ? 0 : 1);
      summary.textContent = pages.length
        ? `已暂存 ${pages.length} 页（${pages.reduce((sum, page) => sum + page.images.length, 0)} 个图片候选）。翻到下一页后点「加入本页并继续」，最后一起发送。`
        : "把当前页面的图片结构（不含正文）交给 Tessera 文件助手分析，再由你在 Tessera 里确认保存。需要多页时，逐页加入后一起发送。";
      sendButton.replaceChildren(svg("send"), total > 1 ? `发送 ${total} 页给助手` : "发送本页给助手");
      scrollButton.replaceChildren(svg(scrolling ? "close" : "download"), scrolling ? "停止滚动" : "先滚动到底部");
    };
    scrollButton.onclick = () => {
      if (scrolling) { stopScroll(); refresh(); return; }
      autoScroll(() => { refresh(); show("已滚动到底部，懒加载的图片已出现在快照里"); });
      refresh();
    };
    addButton.onclick = () => {
      try {
        const pages = addAssistantPage(pageSnapshot());
        show(`已加入第 ${pages.length} 页。请自己翻到下一页，再打开面板继续加入。`);
      } catch (error) { show(error.message, true); }
      refresh();
    };
    sendButton.onclick = () => {
      if (!server) { show("请先在设置中填写 Tessera 服务器地址", true); return; }
      let pages;
      try {
        const current = pageSnapshot();
        const stored = assistantPages().filter(page => page.url !== current.url);
        pages = [...stored, current];
        const images = pages.reduce((sum, page) => sum + page.images.length, 0);
        if (pages.length > ASSISTANT_MAX_PAGES || images > ASSISTANT_MAX_IMAGES) throw new Error("页数或图片候选超过上限，请减少暂存的页面");
        if (!images) throw new Error("这个页面没有找到图片，可以先滚动到底部再试");
        const pending = sendAssistantPages(server, pages);
        show("已打开 Tessera，正在转交快照…");
        pending.then(() => { clearAssistantPages(); refresh(); show("已转交。请在 Tessera 的文件助手里确认后发送。"); })
          .catch(error => show(error.message, true));
      } catch (error) { show(error.message, true); }
    };
    refresh();
    frame("发给文件助手", [
      h("div", { className: "section" }, summary, status),
      h("div", { className: "section actions-row" }, scrollButton, addButton),
    ], { back: () => { stopScroll(); open(currentContext); }, subtitle: location.hostname,
      footer: [h("button", { type: "button", className: "text-btn", onclick: () => { clearAssistantPages(); refresh(); show("已清空暂存的页面"); } }, "清空暂存"),
        h("span", { className: "spacer" }), sendButton] });
  }

  // ----- 保存到 Tessera：本地下载与服务器下载共用的确认与进度页 -----

  /**
   * 批次在页面内存中保存：关闭面板后继续传输、轮询进度，重新打开时主面板顶部显示入口。两种方式共用同一个确认页
   * （保存位置含私密空间、逐项保存文件名），只是读取文件的一方不同：
   * - 本地下载（local）：当前浏览器读取直链 → PUT 临时名 → move 提交；私密空间使用临时授权。
   *   waiting → downloading → uploading → saving → completed（私密操作使用临时授权）。
   * - 服务器下载（server）：打开确认页时先解析，每个分组一行，同组的不同清晰度用下拉选择；开始后逐行创建离线任务并轮询。
   *   私密空间在面板内解锁后直接创建任务。parsing → waiting → creating → submitted。
   */
  // batch：面板里正在查看的批次（确认页或进度页）；batches：已经开始、仍在跟踪的全部批次。
  // 一批还在进行时可以继续勾选并开始新的一批：旧批次在后台继续，主面板为每个批次各显示一条进度横幅。
  let batch = null;
  const batches = [];
  const batchAlive = current => batch === current || batches.includes(current);
  const TERMINAL = ["completed", "failed", "stopped"];
  const PHASE = { resolving: "解析媒体…", downloading: "下载中", merging: "合并中…", saving: "保存中…" };
  const MODE_LABEL = { local: "本地下载", server: "服务器下载" };

  /** 解析结果按文件名判断类型，用于行图标；判断不出时沿用来源资源的类型。 */
  function candidateType(candidate, fallback) {
    const name = String(candidate.name || "").toLowerCase();
    if (/\.(?:jpe?g|png|gif|webp|avif|heic|bmp|svg)$/.test(name)) return "image";
    if (/\.(?:mp4|m4v|webm|mov|mkv|ts)$/.test(name)) return "video";
    if (/\.(?:mp3|m4a|aac|flac|ogg|opus|wav)$/.test(name)) return "audio";
    return fallback === "stream" ? "video" : fallback;
  }

  /** sources：资源地址、{ url, platform }，或网盘选择快照 { url, name, size, cloud }。 */
  function startBatch(sources, mode) {
    if (!settings().server || !settings().key) {
      toast("请先填写 Tessera 地址和访问密钥");
      return openSettings(() => open(currentContext));
    }
    // 已结束的批次记录随新批次清除（和只有一个批次时一样）；进行中的批次保留，新批次与它们并行。
    for (const old of batches.slice()) if (batchDone(old)) batches.splice(batches.indexOf(old), 1);
    // 正在其他批次里处理的文件不重复加入。
    const busy = new Set(batches.flatMap(old => [...old.entries.filter(entry => entryActive(entry, old)), ...old.deferred].map(entry => entry.url)));
    const requested = sources.map(source => typeof source === "string" ? { url: source, platform: null } : source);
    const wanted = requested.filter(source => !busy.has(source.url));
    if (!wanted.length) return toast(requested.length === 1 ? "这个文件正在进行中的批次里" : "所选文件都在进行中的批次里");
    const skipped = requested.length - wanted.length;
    // 按资源列表的显示顺序处理，而不是勾选的先后顺序。
    const listed = collect();
    const known = new Map(listed.map(item => [item.url, item]));
    const byUrl = new Map(wanted.map(source => [source.url, source]));
    const ordered = [...listed.filter(item => byUrl.has(item.url)).map(item => byUrl.get(item.url)), ...wanted.filter(source => !known.has(source.url))];
    // 网盘文件与网页资源都不设数量上限，按设置的每批文件数（batchLimit）自动分批：确认页只列出第一批，
    // 开始后每批创建完任务（或上传完）再处理下一批（网盘直链与解析票据都会过期，不能一次取完）。
    // 批大小在开始时记入 batch.limit，发送途中改设置不影响这一轮。
    const size = batchLimit();
    const all = ordered.map(({ url, platform, cloud, name, size, resent, folder }) => ({ url, platform: platform || null, cloud, resent: Boolean(resent), folder: folder || "",
      type: known.get(url)?.type || (platform ? "video" : "file"), name: name || (mode === "local" ? defaultSaveName(url) : ""), sourceName: name || "", size,
      state: mode === "server" ? "parsing" : "waiting", error: "", tasks: [] }));
    const first = all.slice(0, size);
    batch = { started: false, mode, destination: savedDestination(), limit: size,
      entries: first, deferred: all.slice(first.length), round: 1, rounds: Math.max(1, Math.ceil(all.length / size)), archivedOk: 0 };
    openBatch();
    const resent = all.filter(entry => entry.resent).length;
    if (skipped) toast(`已跳过 ${skipped} 个正在其他批次里处理的文件`);
    else if (resent) toast(resent === all.length ? "所选文件之前已发送过，确认后会再次下载" : `其中 ${resent} 个文件之前已发送过，不需要的可以移除`);
    else if (batch.deferred.length) toast(`共 ${all.length} 个文件，将分 ${batch.rounds} 批自动发送`);
    if (mode === "server") void parseEntries(batch, batch.entries.slice());
  }

  /** 每个批量解析请求最多带的条目数：服务器按「同时解析的链接数」并行检查，整个请求最多等 90 秒（见 /downloads/parse-batch）。 */
  const PARSE_CHUNK = 20;
  let parseBatchMissing = false;

  /** 服务器解析：普通链接与网盘直链每 PARSE_CHUNK 个合成一个批量请求，X／YouTube 链接逐个解析（服务器每次只解析一条平台链接）；两路请求并行。 */
  async function parseEntries(current, entries) {
    // Cloud links are fetched up front in LinkSwift-sized batches (grouped per selection); each row then awaits its own link.
    const groups = new Map();
    for (const entry of entries) if (entry.cloud && !entry.cloudLink) {
      if (!groups.has(entry.cloud.session)) groups.set(entry.cloud.session, []);
      groups.get(entry.cloud.session).push(entry);
    }
    for (const group of groups.values()) cloudResolveAll(group.map(entry => entry.cloud)).forEach((promise, index) => { group[index].cloudLink = promise; });
    const units = [];
    let chunk = [];
    for (const entry of entries) {
      if (entry.platform) { units.push([entry]); continue; }
      chunk.push(entry);
      if (chunk.length === PARSE_CHUNK) { units.push(chunk); chunk = []; }
    }
    if (chunk.length) units.push(chunk);
    for (const entry of entries) { entry.state = "parsing"; entry.error = ""; entry.resolvingCloud = Boolean(entry.cloud); }
    updateBatch();
    const worker = async () => {
      while (units.length && batchAlive(current)) {
        const unit = units.shift();
        if (unit.length === 1 && unit[0].platform) await parseEntry(unit[0], current);
        else await parseChunk(unit, current);
      }
    };
    await Promise.all([worker(), worker()]);
  }

  const parseLive = (entry, current) => batchAlive(current) && current.entries.includes(entry);

  /** 一行的解析请求体：网盘文件先等直链；平台链接单独传 Cookie，文件直链把 Cookie 写进 curl 命令，与网页「下载任务」的规则一致。 */
  async function parsePayload(entry, current) {
    let cloudRequestInfo;
    if (entry.cloud) {
      entry.resolvingCloud = true;
      updateBatch();
      const pending = entry.cloudLink;
      entry.cloudLink = null;
      cloudRequestInfo = await (pending || resolveCloud(entry.cloud));
      if (!parseLive(entry, current)) return null;
      entry.resolvingCloud = false;
      updateBatch();
    }
    const payload = cloudRequestInfo
      ? { input: await curlFor(cloudRequestInfo.url, settings().cookies, cloudRequestInfo.headers, entry.sourceName || entry.name), download_type: "http" }
      : entry.platform
      ? { input: entry.url, cookies: settings().cookies ? await cookieHeader(entry.url) : "" }
      : { input: await curlFor(entry.url) };
    return parseLive(entry, current) ? payload : null;
  }

  function parseFailed(entry, error) {
    entry.state = "parse-error";
    entry.resolvingCloud = false;
    entry.error = error.message;
    entry.challenge = Boolean(error.challenge);
  }

  async function parseEntry(entry, current) {
    entry.state = "parsing"; entry.error = "";
    updateBatch();
    try {
      const payload = await parsePayload(entry, current);
      if (!payload) return;
      const parsed = await api("POST", "/api/v1/downloads/parse", payload);
      if (parseLive(entry, current)) applyParsed(entry, current, parsed.candidates || []);
    } catch (error) {
      parseFailed(entry, error);
    }
    updateBatch();
  }

  /** 一组条目合成一个 /downloads/parse-batch 请求；每行的结果各自生效，单项失败只标红该行。旧版服务器没有批量接口时逐个解析。 */
  async function parseChunk(entries, current) {
    if (parseBatchMissing) {
      for (const entry of entries) if (batchAlive(current)) await parseEntry(entry, current);
      return;
    }
    const ready = [];
    // 网盘直链按 LinkSwift 的节奏陆续到达：每行等到自己的直链（失败的行单独标红），再一起提交。
    await Promise.all(entries.map(async entry => {
      try {
        const payload = await parsePayload(entry, current);
        if (payload) ready.push({ entry, payload });
      } catch (error) {
        parseFailed(entry, error);
      }
    }));
    updateBatch();
    if (!ready.length || !batchAlive(current)) return;
    let parsed;
    try {
      parsed = await api("POST", "/api/v1/downloads/parse-batch", { items: ready.map(item => item.payload) }, { timeout: 150000 });
    } catch (error) {
      if (error.status === 404 || error.status === 405) {
        parseBatchMissing = true;
        for (const { entry } of ready) if (parseLive(entry, current)) await parseEntry(entry, current);
        return;
      }
      for (const { entry } of ready) if (parseLive(entry, current)) parseFailed(entry, error);
      updateBatch();
      return;
    }
    const retry = [];
    ready.forEach(({ entry }, index) => {
      if (!parseLive(entry, current)) return;
      const result = parsed?.results?.[index] || { error: "Tessera 没有返回这一项的解析结果" };
      if (result.retry) retry.push(entry);
      else if (result.error) parseFailed(entry, new Error(result.error));
      else {
        try { applyParsed(entry, current, result.candidates || []); } catch (error) { parseFailed(entry, error); }
      }
    });
    updateBatch();
    // 超出服务器时间预算的项单独再解析一次（直链已取到，不重新取链）。
    for (const entry of retry) if (parseLive(entry, current)) {
      entry.state = "parsing";
      try {
        const parsedOne = await api("POST", "/api/v1/downloads/parse", ready.find(item => item.entry === entry).payload);
        if (parseLive(entry, current)) applyParsed(entry, current, parsedOne.candidates || []);
      } catch (error) {
        parseFailed(entry, error);
      }
      updateBatch();
    }
  }

  /** 把解析结果换成确认页的行：每个分组（X 帖子的每张图、每个视频）一行；同组的不同清晰度默认第一个，可在行内切换。 */
  function applyParsed(entry, current, candidates) {
    if (!candidates.length) throw new Error("没有可下载的文件");
    const groups = new Map();
    for (const candidate of candidates) {
      const key = candidate.group || candidate.ticket;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(candidate);
    }
    const index = current.entries.indexOf(entry);
    if (index < 0) return;
    const room = (current.limit || batchLimit()) - current.entries.length + 1;
    const rows = [...groups.values()].slice(0, Math.max(1, room)).map(variants => ({ url: entry.url, platform: entry.platform, cloud: entry.cloud, sourceName: entry.sourceName, resent: entry.resent, folder: entry.folder || "",
      type: candidateType(variants[0], entry.type), variants, candidate: variants[0], name: entry.nameEdited ? entry.name : entry.sourceName || variants[0].name, nameEdited: Boolean(entry.nameEdited),
      autoRound: entry.autoRound, state: current.started && !entry.autoRound ? "error" : "waiting", error: "", tasks: [] }));
    current.entries.splice(index, 1, ...rows);
  }

  /** 可以编辑并参与保存的条目：本地下载全部条目，服务器下载只有解析成功的条目。 */
  const nameable = (current, entry) => current.mode === "local" || Boolean(entry.candidate);

  function batchNameProblems(current) {
    const problems = new Map(), seen = new Map();
    for (const entry of current.entries) {
      if (!nameable(current, entry) || current.started && !entryFailed(entry)) continue;
      const problem = saveNameProblem(entry.name);
      if (problem) { problems.set(entry, problem); continue; }
      // 网盘文件夹里的文件保存到各自的子目录：同名只在同一目录里才算重复。
      const name = (entry.folder || "") + entry.name.trim().normalize("NFC");
      if (seen.has(name)) {
        problems.set(entry, "本批次保存文件名重复，请修改");
        problems.set(seen.get(name), "本批次保存文件名重复，请修改");
      } else seen.set(name, entry);
    }
    return problems;
  }

  function syncBatchNames() {
    if (!batch) return;
    const problems = batchNameProblems(batch);
    for (const entry of batch.entries) {
      if (!entry.row) continue;
      const problem = problems.get(entry) || "";
      entry.row.nameError.textContent = problem;
      entry.row.nameError.hidden = !problem || entry.row.nameInput.hidden;
      entry.row.nameInput.setAttribute("aria-invalid", String(Boolean(problem)));
      const retry = entry.row.action.querySelector("[data-retry]");
      if (retry) retry.disabled = batch.running || Boolean(problem);
    }
    if (batch.submit) {
      const ready = batch.entries.filter(entry => entry.state === "waiting").length;
      const parsing = batch.entries.some(entry => entry.state === "parsing");
      batch.submit.disabled = problems.size > 0 || parsing || !ready;
      const label = batch.submit.querySelector("span");
      label.textContent = parsing ? "正在解析…" : `${batch.mode === "local" ? "开始上传" : "开始下载"} ${ready} 项`;
    }
    const retryAll = panel?.querySelector("[data-retry-failed]");
    if (retryAll) retryAll.disabled = batch.running || problems.size > 0;
  }

  const entryActive = (entry, current = batch) => ["parsing", "creating", "downloading", "uploading", "saving"].includes(entry.state)
    || entry.state === "waiting" && current.started
    || entry.state === "submitted" && entry.tasks.some(task => !TERMINAL.includes(task.status));
  const entryOk = entry => entry.state === "completed" || entry.state === "submitted" && entry.tasks.length > 0 && entry.tasks.every(task => task.status === "completed");
  const entryFailed = entry => ["error", "stopped", "parse-error"].includes(entry.state) || entry.state === "submitted" && entry.tasks.some(task => task.status === "failed" || task.status === "stopped");
  const pendingRounds = (current = batch) => current?.deferred?.length || 0;
  const batchDone = (current = batch) => !current || current.started && !current.entries.some(entry => entryActive(entry, current)) && !pendingRounds(current);
  let localQueue = Promise.resolve();
  /** 依次执行本地下载（跨批次）：每个文件等前一个处理完再开始。 */
  function localTurn(fn) {
    const run = localQueue.then(fn, fn);
    localQueue = run.catch(() => {});
    return run;
  }

  async function runBatch(auto = false, current = batch) {
    if (current.running) return;
    if (current.mode === "local") for (const entry of current.entries) entry.name ??= defaultSaveName(entry.url);
    // 自动续发的批次沿用原文件名，不因前面批次里改坏的失败行而停下（服务器会为同名文件自动改名）。
    const problem = auto ? null : batchNameProblems(current).values().next().value;
    if (problem) return toast(problem);
    const queue = current.entries.filter(entry => entry.state === "waiting");
    if (!queue.length) return toast("没有可保存的文件");
    if (current.destination.private) {
      current.running = true;
      try { await ensurePrivate(current.config || settings()); }
      catch (error) { current.running = false; current.needsUnlock = true; updateBatch(); return toast(error.message); }
      current.needsUnlock = false;
    }
    // 开始后未解析成功的行按失败处理，可单独重试。
    if (!current.started) for (const entry of current.entries) if (entry.state === "parse-error") entry.state = "error";
    current.started = true;
    if (!batches.includes(current)) batches.push(current);
    current.running = true;
    current.controller = new AbortController();
    current.config ||= settings();
    selected.clear();
    rememberDestination(current.destination);
    const privateSpace = current.destination.private;
    updateBatch();
    if (current.mode === "local") {
      try {
        const folder = await api("GET", `/api/v1/folders?prefix=${encodeURIComponent(current.destination.path)}&limit=1`, undefined,
          { config: current.config, signal: current.controller.signal, privateSpace });
        if (!folder?.writable) throw new Error("访问密钥不能写入所选目录，请更改保存位置或密钥授权");
      } catch (error) {
        for (const entry of queue) { entry.state = error.name === "AbortError" ? "stopped" : "error"; entry.error = error.message; }
        current.running = false;
        return updateBatch();
      }
    }
    const worker = async () => {
      while (queue.length && batchAlive(current) && !current.controller.signal.aborted) {
        const entry = queue.shift();
        // 本地下载全局一次只处理一个文件：多个批次同时进行时依次上传。
        await (current.mode === "local" ? localTurn(() => current.controller.signal.aborted ? undefined : uploadEntry(entry, current)) : createEntry(entry, current));
      }
    };
    // 本地下载一次只处理一个文件（内存与带宽）；服务器下载两路创建任务。
    await Promise.all(current.mode === "local" ? [worker()] : [worker(), worker()]);
    current.running = false;
    updateBatch();
    // 这一批任务创建完成后继续下一批；私密授权过期时再请求解锁，不逐批跳转确认。
    if (batchAlive(current) && pendingRounds(current) && !current.controller.signal.aborted) void nextRound(current);
  }

  /** 下一批沿用已确认的位置；私密授权有效时直接继续，失效时再请求解锁。 */
  async function nextRound(current) {
    if (current.running || !pendingRounds(current) || !batchAlive(current)) return;
    const done = current.entries.filter(entryOk);
    current.archivedOk += done.length;
    current.entries = current.entries.filter(entry => !done.includes(entry));
    const chunk = current.deferred.splice(0, current.limit || batchLimit());
    for (const entry of chunk) entry.autoRound = true;
    current.round += 1;
    current.entries.push(...chunk);
    if (current.mode === "server") {
      current.running = true;
      updateBatch();
      await parseEntries(current, chunk);
      current.running = false;
      if (!batchAlive(current)) return;
    }
    if (current.entries.some(entry => entry.autoRound && entry.state === "waiting")) return runBatch(true, current);
    updateBatch();
    return nextRound(current);
  }

  /** 放弃还没开始的批次（已创建的任务不受影响）。 */
  function dropRounds() {
    if (!batch || !pendingRounds()) return;
    const count = batch.deferred.length;
    batch.deferred = [];
    toast(`已放弃剩余 ${count} 个文件`);
    updateBatch();
  }

  async function resumePrivate(current = batch) {
    try {
      await ensurePrivate(current.config || settings());
      current.needsUnlock = false;
      if (current.entries.some(entry => entry.state === "waiting")) return runBatch(true, current);
      updateBatch(); schedulePoll(0);
    } catch (error) { toast(error.message); }
  }

  async function uploadEntry(entry, current) {
    entry.state = "downloading"; entry.error = ""; entry.received = 0; entry.total = null; entry.uploaded = 0;
    updateBatch();
    const signal = current.controller.signal;
    let staged = false;
    try {
      const { blob, mime } = await browserDownload(entry.url, entry.type, { signal, cookies: current.config.cookies,
        onprogress: (received, total) => { entry.received = received; entry.total = total; updateBatch(); } });
      if (signal.aborted) throw stoppedError();
      entry.size = blob.size;
      entry.path ||= current.destination.path + uploadSaveName(entry, mime);
      entry.stagePath ||= current.destination.path + browserTemporaryName();
      entry.state = "uploading";
      updateBatch();
      staged = true;
      const result = await api("PUT", `/api/v1/files?path=${encodeURIComponent(entry.stagePath)}`, blob,
        { config: current.config, signal, contentType: mime, binary: true, privateSpace: current.destination.private,
          onprogress: event => { entry.uploaded = event.loaded || 0; updateBatch(); } });
      if (result?.key !== entry.stagePath || result.size !== blob.size) throw new Error("Tessera 未确认文件保存成功，请检查保存目录后重试");
      entry.state = "saving";
      updateBatch();
      const moved = await api("POST", "/api/v1/move", { from: entry.stagePath, to: entry.path, conflict: "skip" }, { config: current.config, signal, privateSpace: current.destination.private });
      if (moved?.skipped) throw new Error("保存目录已有同名文件，已保留原文件；请修改保存文件名后重试");
      if (moved?.moved !== 1) throw new Error("Tessera 未确认保存文件名，请检查保存目录后重试");
      entry.state = "completed";
      markSent([entry.url]);
    } catch (error) {
      let cleanupFailed = false;
      if (staged) {
        try {
          const removed = await api("POST", "/api/v1/delete", { paths: [entry.stagePath] }, { config: current.config, timeout: 10000, privateSpace: current.destination.private });
          if (!removed?.results?.some(item => item.path === entry.stagePath)) cleanupFailed = true;
        } catch { cleanupFailed = true; }
      }
      entry.state = error.name === "AbortError" ? "stopped" : "error";
      entry.challenge = Boolean(error.challenge);
      entry.error = error.message + (cleanupFailed ? `；未完成的上传清理失败，请检查 ${entry.stagePath}` : "");
      markSent([entry.url], false);
    }
    updateBatch();
  }

  function stopBatch() {
    if (!batch || batch.mode !== "local") return;
    batch.controller.abort();
    for (const entry of batch.entries) if (entry.state === "waiting") { entry.state = "stopped"; entry.error = "已停止"; }
    updateBatch();
  }

  async function createEntry(entry, current) {
    entry.state = "creating"; entry.error = ""; entry.tasks = [];
    updateBatch();
    try {
      const result = await api("POST", "/api/v1/downloads", {
        items: [{ ticket: entry.candidate.ticket, name: entry.name.trim().normalize("NFC"), ...(entry.folder ? { folder: entry.folder } : {}) }],
        destination: current.destination.path,
      }, { config: current.config, privateSpace: current.destination.private });
      entry.tasks = result.tasks || [];
      entry.state = "submitted";
      markSent([entry.url]);
    } catch (error) {
      entry.state = "error";
      entry.error = error.message;
      markSent([entry.url], false);
    }
    updateBatch();
    schedulePoll();
  }

  /** 重试：解析失败的行重新解析（成功后按新行继续），其余行重新传输或重新创建任务。 */
  async function retryEntries(entries) {
    if (batch.running) return toast("请等待当前批次完成或停止后再重试");
    const problem = batchNameProblems(batch).values().next().value;
    if (problem) return toast(problem);
    const current = batch;
    const unparsed = entries.filter(entry => entry.cloud || !nameable(current, entry));
    for (const entry of unparsed) if (entry.cloud) { entry.cloud.session.clear(); entry.candidate = null; markSent([entry.url], false); }
    for (const entry of entries) {
      if (unparsed.includes(entry)) continue;
      if (!nameable(current, entry)) continue;
      entry.state = "waiting"; entry.error = ""; entry.tasks = []; entry.challenge = false; entry.delivered = false;
    }
    if (unparsed.length) {
      // 先按未开始的状态解析，新行为 waiting，再一起开始。
      const started = current.started;
      current.started = false;
      current.running = true;
      await parseEntries(current, unparsed);
      current.running = false;
      current.started = started;
      if (!batchAlive(current)) return;
    }
    void runBatch();
  }

  /** 进度页清除已结束的行（不影响已保存的文件和服务器任务）；全部清除后回到资源列表。 */
  function clearEntries(entries) {
    const gone = new Set(entries.filter(entry => !entryActive(entry)));
    batch.entries = batch.entries.filter(entry => !gone.has(entry));
    if (!batch.entries.length) return clearBatch();
    renderBatch();
  }

  /** 确认页移除一行；全部移除后回到资源列表。 */
  function removeEntry(entry) {
    batch.entries = batch.entries.filter(item => item !== entry);
    if (!batch.entries.length) { batch = null; return open(currentContext); }
    renderBatch();
  }

  let pollTimer = 0;
  function schedulePoll(delay = 1500) {
    if (!pollTimer) pollTimer = setTimeout(poll, delay);
  }
  async function poll() {
    pollTimer = 0;
    const tracked = [...new Set([...batches, ...(batch ? [batch] : [])])];
    let changed = false;
    for (const current of tracked) {
      const ids = current.entries.flatMap(entry => entry.tasks.filter(task => !TERMINAL.includes(task.status)).map(task => task.id));
      if (!ids.length) continue;
      try {
        // 按接口的 100 个编号上限分页；私密状态轮询不续期。
        const tasks = [];
        for (let index = 0; index < ids.length; index += 100)
          tasks.push(...(await api("GET", `/api/v1/downloads?ids=${ids.slice(index, index + 100).join(",")}`, undefined,
            { config: current.config || settings(), privateSpace: current.destination.private })).tasks);
        if (!batchAlive(current)) continue;
        const fresh = new Map(tasks.map(task => [task.id, task]));
        for (const entry of current.entries) entry.tasks = entry.tasks.map(task => fresh.get(task.id) || task);
        // 下载失败或被停止的资源不算已发送，下次全选时重新包含。
        markSent(current.entries.filter(entry => entry.state === "submitted" && entry.tasks.some(task => task.status === "failed" || task.status === "stopped")).map(entry => entry.url), false);
        changed = true;
      } catch { /* 网络抖动：下一轮再试 */ }
    }
    if (changed) updateBatch();
    if (tracked.some(current => batchAlive(current) && current.entries.some(entry => entryActive(entry, current)))) schedulePoll(2000);
  }

  function updateBatch() {
    if (!panel) return;
    if (panel.dataset.view === "batch") renderBatch();
    else if (panel.dataset.view === "main") renderBanner();
  }

  function batchSummary(current = batch) {
    // 自动分批时：已收起的完成行与未开始的批次也计入总数。
    const total = current.entries.length + (current.archivedOk || 0) + pendingRounds(current);
    const ok = current.entries.filter(entryOk).length + (current.archivedOk || 0);
    const failed = current.entries.filter(entryFailed).length;
    return { total, ok, failed, finished: batchDone(current) };
  }

  /** 批次整体状态：图标、语气与标题，横幅和进度页共用。 */
  function batchHeadline(current = batch) {
    const { total, ok, failed, finished } = batchSummary(current);
    const label = MODE_LABEL[current.mode];
    const running = total - ok - failed;
    const tone = !finished ? "run" : failed ? ok ? "warn" : "err" : "ok";
    return {
      tone, total, ok, failed, running, finished,
      icon: tone === "run" ? "loader" : tone === "ok" ? "check" : "alert",
      title: !finished ? `正在${label}` : tone === "ok" ? `${label}完成` : tone === "warn" ? `${label}部分失败` : `${label}失败`,
      width: `${total ? (ok + failed) / total * 100 : 0}%`,
      bar: `progress${finished ? !failed ? " done" : !ok ? " failed" : "" : ""}`,
    };
  }

  /** 清除批次记录（不影响已保存的文件和服务器任务）。 */
  function clearBatch(current = batch) {
    if (current && current.started && !batchDone(current)) return toast("还有文件在传输，请等待完成或停止后再清除");
    if (batches.includes(current)) batches.splice(batches.indexOf(current), 1);
    if (batch !== current) return renderBanner();
    batch = null;
    if (panel && panel.dataset.view === "batch") open(currentContext);
    else renderBanner();
  }

  /** 主面板顶部的批次入口：每个已开始的批次一条，节点按批次复用，之后原地更新文字和进度，避免轮询时替换节点吞掉点击；结束后可关闭。 */
  const banners = new WeakMap();
  function renderBanner() {
    const target = panel && panel.querySelector(".banner-host");
    if (!target) return;
    const shown = batches.filter(current => current.started);
    target.hidden = !shown.length;
    syncChildren(target, shown.map(bannerFor));
  }
  function bannerFor(current) {
    let banner = banners.get(current);
    if (!banner) {
      banner = h("div", { className: "batch-banner" },
        h("button", { type: "button", className: "banner-open", onclick: () => openBatch(current) },
          h("span", { className: "status-icon" }),
          h("div", { className: "meta" }, h("div", { className: "name" }), h("div", { className: "sub" }), h("div", { className: "progress thin" }, h("span"))),
          svg("chevron")),
        iconButton("close", "清除记录", () => clearBatch(current), "banner-close"));
      banners.set(current, banner);
    }
    const head = batchHeadline(current);
    banner.className = `batch-banner tone-${head.tone}`;
    const icon = banner.querySelector(".status-icon");
    if (icon.dataset.icon !== head.icon) { icon.dataset.icon = head.icon; icon.replaceChildren(svg(head.icon, 16, head.icon === "check" ? 2.6 : 2)); }
    banner.querySelector(".name").textContent = head.title;
    banner.querySelector(".sub").textContent = head.finished
      ? `${[head.ok ? `成功 ${head.ok}` : "", head.failed ? `失败 ${head.failed}` : ""].filter(Boolean).join(" · ")} · 点击查看详情`
      : `已完成 ${head.ok} / ${head.total}${head.failed ? ` · 失败 ${head.failed}` : ""}`;
    banner.querySelector(".progress").className = `${head.bar} thin`;
    banner.querySelector(".progress").hidden = head.finished;
    banner.querySelector(".progress > span").style.width = head.width;
    banner.querySelector(".banner-close").hidden = !head.finished;
    return banner;
  }

  function openBatch(current = batch) {
    batch = current;
    if (!batch) return open(currentContext);
    frame(MODE_LABEL[batch.mode], h("div", { className: "batch-host" }), { back: () => open(currentContext), footer: [], wide: true });
    panel.dataset.view = "batch";
    renderBatch();
  }

  /** 一个条目的状态文字、语气与进度（0–1，null 为不确定进度，undefined 为不显示）。 */
  function entryStatus(entry) {
    if (batch.destination.private && !privateCurrent(batch.config || settings()))
      return { text: "私密空间已锁定，解锁后查看保存详情" };
    if (entry.state === "waiting") return { text: batch.started ? "等待中" : "" };
    if (entry.state === "parsing") return { text: entry.resolvingCloud ? "正在获取网盘直链…" : "服务器解析中…", tone: "run", progress: null };
    if (entry.state === "parse-error") return { text: entry.error || "解析失败", tone: "err" };
    if (entry.state === "creating") return { text: "提交任务…", tone: "run", progress: null };
    if (entry.state === "error") return { text: entry.error || "保存失败", tone: "err" };
    if (entry.state === "stopped") return { text: entry.error || "已停止", tone: "err" };
    if (entry.state === "saving") return { text: "正在保存文件…", tone: "run", progress: null };
    if (entry.state === "completed") return { text: `已上传 · ${formatSize(entry.size)} · ${entry.path}`, tone: "ok", progress: 1 };
    if (entry.state === "downloading" || entry.state === "uploading") {
      const upload = entry.state === "uploading";
      const received = upload ? entry.uploaded : entry.received;
      const total = upload ? entry.size : entry.total;
      const progress = total ? Math.min(1, received / total) : null;
      return { text: `${upload ? "上传中" : "浏览器下载中"} · ${progress === null ? formatSize(received) : `${Math.floor(progress * 100)}%`}${upload && progress === 1 ? " · 等待保存确认" : ""}`, tone: "run", progress };
    }
    const task = entry.tasks.find(item => !TERMINAL.includes(item.status)) || entry.tasks.find(item => item.status !== "completed") || entry.tasks[0];
    if (!task) return { text: "已提交" };
    if (task.status === "completed") return { text: `已完成 · ${formatSize(task.stored_bytes || task.size)} · ${task.key}`, tone: "ok", progress: 1 };
    if (task.status === "failed") return { text: task.error || "下载失败", tone: "err" };
    if (task.status === "stopped") return { text: task.error ? `已停止：${task.error}` : "已停止", tone: "err" };
    if (task.status === "queued") return { text: "服务器排队中", progress: 0 };
    if (task.status === "interrupted") return { text: task.error || "等待重试", tone: "run", progress: null };
    const fraction = task.segments_total ? task.segments_done / task.segments_total
      : task.size ? Math.min(1, (task.received || 0) / task.size) : null;
    const parts = [`服务器${PHASE[task.phase] || "下载中"}`];
    if (task.phase === "downloading" || !task.phase) {
      if (fraction != null) parts.push(`${Math.floor(fraction * 100)}%`);
      else if (task.received) parts.push(formatSize(task.received));
      if (task.speed) parts.push(`${formatSize(task.speed)}/s`);
    }
    return { text: parts.join(" · "), tone: "run", progress: task.phase === "downloading" || !task.phase ? fraction : null };
  }

  /**
   * 批次条目的行：每个条目只创建一次，轮询时原地更新状态，保证按钮可以点到。
   * 紧凑布局：缩略图 | 保存文件名（可直接修改）+ 一行说明或状态 + 细进度条 | 行尾按钮。
   */
  let nameFieldSequence = 0;
  function batchRow(entry) {
    if (!entry.row) {
      const thumbnail = entry.type === "image" && !entry.platform && !entry.cloud;
      const tile = h("span", { className: "tile" }, thumbnail
        ? h("img", { src: entry.url, alt: "", loading: "lazy", referrerpolicy: "no-referrer", onerror: event => event.currentTarget.replaceWith(svg("image", 18)) })
        : svg(TYPE_ICON[entry.type] || "file", 18));
      const badge = h("span", { className: "tile-badge", hidden: true }, svg("check", 10, 3.4));
      const state = h("div", { className: "state" });
      const bar = h("div", { className: "progress thin" }, h("span"));
      const action = h("span", { className: "item-actions" });
      const errorId = `tessera-name-error-${++nameFieldSequence}`;
      const nameInput = h("input", { type: "text", className: "name-input", value: entry.name || "",
        "aria-label": `保存文件名：${fileName(entry.url)}`, "aria-describedby": errorId, autocomplete: "off", spellcheck: "false", title: "保存文件名，可直接修改" });
      const nameError = h("div", { id: errorId, className: "error", hidden: true });
      const nameText = h("div", { className: "name", title: entry.url });
      nameInput.addEventListener("input", () => { entry.name = nameInput.value; entry.nameEdited = true; entry.path = null; syncBatchNames(); });
      let domain = "";
      try { domain = new URL(entry.url).hostname.replace(/^www\./, ""); } catch { /* 忽略无效地址 */ }
      const size = h("span", { className: "size" });
      const sub = h("div", { className: "sub", title: entry.url }, entry.resent ? h("span", { className: "sent-tag", title: "之前已发送过，确认后会再次下载" }, "已发送过") : null,
        entry.folder ? h("span", { className: "folder-tag", title: `保存到子目录 ${entry.folder}` }, svg("folder", 12), entry.folder.replace(/\/$/, "")) : null,
        h("span", {}, `${TYPE_LABEL[entry.type] || "文件"}${domain ? ` · ${domain}` : ""}`));
      // 服务器解析出同一分组的多个清晰度：下拉切换，未改过文件名时跟随候选的默认名。
      if (entry.variants?.length > 1) {
        const select = h("select", { className: "variant", "aria-label": "清晰度",
          onchange: () => {
            entry.candidate = entry.variants[select.selectedIndex];
            if (!entry.nameEdited) { entry.name = entry.candidate.name; nameInput.value = entry.name; }
            syncBatchNames();
            renderBatch();
          } }, entry.variants.map(variant => h("option", {}, variant.variant || variant.name)));
        sub.append(select);
      } else if (entry.candidate?.variant) sub.append(h("span", {}, entry.candidate.variant));
      if (entry.candidate || batch.mode === "local") sub.append(size);
      const warnings = h("div", { className: "warn" }, (entry.candidate?.warnings || []).join("；"));
      warnings.hidden = !entry.candidate?.warnings?.length;
      entry.row = { node: h("div", { className: "item batch-item" }, h("span", { className: "tile-wrap" }, tile, badge),
        h("div", { className: "meta" }, nameText, nameInput, nameError, sub, warnings, state, bar), action),
        badge, state, bar, action, nameInput, nameText, nameError, sub, size, actionKey: "" };
    }
    const { badge, state, bar, action, nameInput, nameText, sub, size } = entry.row;
    const failed = entryFailed(entry) && !entryActive(entry);
    const editable = nameable(batch, entry) && (!batch.started || failed);
    nameInput.hidden = !editable;
    nameInput.disabled = batch.running;
    nameText.hidden = editable;
    nameText.textContent = entry.name || fileName(entry.url);
    if (entry.candidate) size.textContent = formatSize(entry.candidate.size);
    else if (resourceMeta.get(entry.url)?.size) size.textContent = formatSize(resourceMeta.get(entry.url).size);
    const status = entryStatus(entry);
    badge.hidden = !entryOk(entry);
    sub.hidden = Boolean(status.text);
    state.className = `state${status.tone ? " " + status.tone : ""}`;
    state.textContent = status.text;
    state.title = status.text;
    state.hidden = !status.text;
    bar.hidden = status.progress === undefined || status.tone === "ok";
    bar.className = `progress thin${status.progress == null ? " indeterminate" : ""}`;
    bar.firstChild.style.width = `${(status.progress || 0) * 100}%`;
    // 行尾按钮只在形态变化时重建：确认页可移除、解析失败可重新解析；开始后失败可重试，被 Cloudflare 验证拦下时先打开验证。
    const retry = batch.started ? failed : entry.state === "parse-error";
    const removable = !batch.started || entryOk(entry) || failed;
    const actionKey = `${batch.started}:${retry}:${retry && Boolean(entry.challenge)}:${removable}`;
    if (entry.row.actionKey !== actionKey) {
      action.replaceChildren(...[
        retry && entry.challenge ? h("button", { type: "button", className: "btn small", title: "在新标签页打开资源，完成人机验证后回来重试",
          onclick: () => gm.openTab(entry.cloud?.url || entry.url) }, svg("shield", 14), "打开验证") : null,
        retry ? h("button", { type: "button", className: "icon-btn", title: batch.started ? "重试" : "重新解析", "aria-label": "重试", "data-retry": "",
          onclick: () => batch.started ? retryEntries([entry]) : void parseEntries(batch, [entry]) }, svg("retry")) : null,
        removable ? iconButton("close", batch.started ? "从列表清除" : "移除", () => batch.started ? clearEntries([entry]) : removeEntry(entry), "row-clear") : null,
      ].filter(Boolean));
      entry.row.actionKey = actionKey;
    }
    // 运行中也可以清除已结束的行；重试与重新解析要等这一轮结束。
    for (const button of action.querySelectorAll(".icon-btn:not(.row-clear)")) button.disabled = batch.running;
    return entry.row.node;
  }

  /**
   * 确认页与进度页：骨架按阶段（draft／run）只创建一次，之后原地更新计数、列表和按钮，
   * 解析结果陆续到达或轮询刷新时不会打断正在输入的文件名。
   */
  function renderBatch() {
    const target = panel && panel.dataset.view === "batch" && panel.querySelector(".batch-host");
    const footer = panel && panel.querySelector("footer");
    if (!target || !batch) return;
    const local = batch.mode === "local";
    const stage = batch.started ? "run" : "draft";
    if (target.dataset.stage !== stage || target.dataset.dest !== JSON.stringify(batch.destination)) {
      target.dataset.stage = stage;
      target.dataset.dest = JSON.stringify(batch.destination);
      footer.dataset.mode = "";
      const list = h("div", { className: "list batch-list" });
      if (!batch.started) {
        const privateNote = local
          ? "在当前面板解锁后直接上传到私密目录；解锁期间可以连续发送，无需逐批跳转确认。请保持来源网页打开。"
          : "在当前面板解锁后直接创建私密下载任务；私密操作自动续期，闲置超时后重新解锁。解析结果 30 分钟内有效。";
        target.replaceChildren(
          destinationRow(() => batch.destination, value => { batch.destination = value; rememberDestination(value); renderBatch(); }),
          h("div", { className: "section" },
            h("div", { className: "section-head" }, h("h2", {}, "保存的文件", h("span", { className: "count" }))),
            pendingRounds() ? h("p", { className: "hint rounds-note" }, svg("rows", 14),
              h("span", {}, `共 ${batch.entries.length + pendingRounds()} 个文件，分 ${batch.rounds} 批自动发送：下面是第 1 批（可改名、移除），之后每批在上一批创建好任务后自动获取直链并提交，沿用同一保存位置，按网盘原文件名保存。${batch.destination.private ? "私密解锁有效期间同样自动续发，无需逐批确认。" : ""}`)) : null,
            list),
          h("p", { className: "hint batch-note" }, svg(local ? "globe" : "download"), h("span", {}, batch.destination.private ? privateNote : local
            ? "由当前浏览器读取文件后上传，适合服务器被拒绝（防盗链、登录、人机验证）的资源。单文件最多 64 MiB；请保持网页打开，关闭面板后传输会继续。"
            : "由 Tessera 服务器下载，可关闭网页。文件名可直接修改；视频可在行内选择清晰度。")));
        const submit = h("button", { type: "button", className: "btn primary", onclick: () => void runBatch() },
          svg(batch.destination.private && !local ? "lock" : local ? "upload" : "send"), h("span"));
        batch.submit = submit;
        footer.replaceChildren(h("span", { className: "selection" }), h("span", { className: "spacer" }),
          h("button", { type: "button", className: "btn ghost", onclick: () => { batch = null; open(currentContext); } }, "取消"), submit);
      } else {
        batch.submit = null;
        target.replaceChildren(h("div", { className: "overview" },
          h("div", { className: "overview-line" }, h("span", { className: "status-icon" }),
            h("div", { className: "meta" }, h("strong"), h("span", { className: "sub" })),
            h("div", { className: "stats" })),
          h("div", { className: "progress" }, h("span"))), list);
      }
    }
    syncChildren(target.querySelector(".batch-list"), batch.entries.map(batchRow));
    if (!batch.started) {
      const count = target.querySelector(".count");
      count.textContent = pendingRounds() ? `${batch.entries.length} / 共 ${batch.entries.length + pendingRounds()}` : String(batch.entries.length);
      const parsing = batch.entries.filter(entry => entry.state === "parsing").length;
      const failedParse = batch.entries.filter(entry => entry.state === "parse-error").length;
      footer.querySelector(".selection").textContent = parsing ? `正在解析 ${parsing} 项` : failedParse ? `${failedParse} 项解析失败，开始时跳过` : pendingRounds() ? `第 1 批 ${batch.entries.length} 个 · 共 ${batch.rounds} 批` : `${batch.entries.length} 个文件`;
      syncBatchNames();
      return;
    }
    const head = batchHeadline();
    const { ok, failed, finished } = head;
    const overview = target.querySelector(".overview");
    const privateSpace = batch.destination.private;
    overview.className = `overview tone-${head.tone}`;
    const icon = overview.querySelector(".status-icon");
    if (icon.dataset.icon !== head.icon) { icon.dataset.icon = head.icon; icon.replaceChildren(svg(head.icon, 18, head.icon === "check" ? 2.6 : 2)); }
    overview.querySelector("strong").textContent = head.title;
    const roundText = batch.rounds > 1 ? `第 ${batch.round} / ${batch.rounds} 批 · ` : "";
    overview.querySelector(".sub").textContent = roundText + (privateSpace ? `私密空间 · ${privateCurrent(batch.config || settings()) ? "已解锁" : "已锁定"}` : `保存到「${destinationLabel(batch.destination)}」`);
    // 统计胶囊：数量变化时才重建。
    const stats = overview.querySelector(".stats");
    const statKey = `${ok}:${failed}:${head.running}`;
    if (stats.dataset.key !== statKey) {
      stats.dataset.key = statKey;
      stats.replaceChildren(...[
        ok ? h("span", { className: "stat ok" }, `成功 ${ok}`) : null,
        failed ? h("span", { className: "stat err" }, `失败 ${failed}`) : null,
        head.running ? h("span", { className: "stat run" }, `进行中 ${head.running}`) : null,
      ].filter(Boolean));
    }
    overview.querySelector(".progress").className = head.bar;
    overview.querySelector(".progress > span").style.width = head.width;
    // 底部按钮只在形态变化时重建（运行中／结束、有无失败项），轮询不会替换正在点击的按钮。
    const failedEntries = batch.entries.filter(entry => entryFailed(entry) && !entryActive(entry));
    const switchable = !local && finished ? failedEntries.filter(entry => !entry.platform && browserEligible(entry)) : [];
    const clearable = batch.entries.some(entry => entryOk(entry));
    const needsUnlock = privateSpace && !batch.running && (batch.needsUnlock || !privateCurrent(batch.config || settings()));
    const mode = `${finished ? "done" : "run"}:${failedEntries.length > 0}:${switchable.length > 0}:${Boolean(batch.running)}:${clearable}:${pendingRounds()}:${Boolean(needsUnlock)}`;
    if (footer.dataset.mode === mode) { syncBatchNames(); return; }
    footer.dataset.mode = mode;
    const server = (batch.config || settings()).server.replace(/\/+$/, "");
    const link = server + (privateSpace ? "/?view=private" : local ? "/?view=files" : "/?view=downloads");
    footer.replaceChildren(...[
      h("button", { type: "button", className: "btn ghost", onclick: () => gm.openTab(link) }, local || privateSpace ? "查看文件" : "查看下载任务"),
      h("span", { className: "spacer" }),
      switchable.length ? h("button", { type: "button", className: "btn ghost", title: "服务器被来源拒绝时，用当前浏览器读取后上传",
        onclick: () => startBatch([...new Set(switchable.map(entry => entry.url))], "local") }, "失败项改用本地下载") : null,
      failedEntries.length ? h("button", { type: "button", className: "btn", "data-retry-failed": "", disabled: batch.running,
        onclick: () => retryEntries(batch.entries.filter(entry => entryFailed(entry) && !entryActive(entry))) }, "重试失败项") : null,
      local && !finished ? h("button", { type: "button", className: "btn", onclick: stopBatch }, "停止") : null,
      pendingRounds() ? h("button", { type: "button", className: "btn ghost", title: "不再发送还没开始的批次，已创建的任务照常下载", onclick: dropRounds }, `放弃剩余 ${pendingRounds()} 个`) : null,
      needsUnlock ? h("button", { type: "button", className: "btn primary", onclick: () => void resumePrivate() }, svg("lock"), "解锁并继续") : null,
      pendingRounds() && privateSpace && !batch.running && !needsUnlock && !batch.entries.some(entry => entry.state === "waiting") ? h("button", { type: "button", className: "btn primary", title: "获取下一批直链并发送到私密目录（授权过期时需重新解锁）",
        onclick: () => void nextRound(batch) }, svg("send"), `发送下一批（第 ${batch.round + 1} / ${batch.rounds} 批）`) : null,
      clearable && (failedEntries.length || !finished) ? h("button", { type: "button", className: "btn ghost", title: "从列表移除已完成的项，保留失败项",
        onclick: () => clearEntries(batch.entries.filter(entryOk)) }, "清除已完成") : null,
      finished
        ? h("button", { type: "button", className: "btn primary", title: "清除这批记录并返回资源列表", onclick: clearBatch }, svg("check"), "完成")
        : h("button", { type: "button", className: "btn primary", onclick: close, title: "关闭面板，传输和进度跟踪在后台继续" }, "后台运行"),
    ].filter(Boolean));
    syncBatchNames();
  }

  // ----- 设置 -----

  function toggleRow(input, title, description) {
    return h("label", { className: "switch-row" },
      h("div", { className: "meta" }, h("div", { className: "name" }, title), h("div", { className: "sub" }, description)),
      h("span", { className: "switch" }, input, h("span")));
  }

  function openSettings(back) {
    mount();
    const current = settings();
    const server = h("input", { type: "url", value: current.server, placeholder: "https://drive.example.com" });
    const key = h("input", { type: "password", value: current.key, placeholder: "AccessKeyId:Secret", autocomplete: "off" });
    let dest = { path: current.destination || "", private: Boolean(current.destinationPrivate) };
    const cookies = h("input", { type: "checkbox", checked: current.cookies });
    const showFab = h("input", { type: "checkbox", checked: current.fab });
    const cloudBatch = h("input", { type: "number", min: "1", max: String(BATCH_MAX), step: "1", inputMode: "numeric",
      value: String(batchLimit(current.cloudBatch)) });
    // 显示范围：两种模式各自保留一份列表，切换模式时把输入框内容换成对应列表。
    const lists = { exclude: [...current.excludeSites], include: [...current.includeSites] };
    let mode = current.siteMode === "include" ? "include" : "exclude";
    const sites = h("textarea", { spellcheck: "false", rows: 4 });
    const scopeHint = h("span", { className: "hint" });
    const parseSites = () => sites.value.split(/[\n,，]+/).map(line => line.trim()).filter(Boolean);
    const modeButtons = {};
    const showMode = () => {
      sites.value = lists[mode].join("\n");
      sites.placeholder = mode === "include" ? "每行一个域名，例如\nx.com\nyoutube.com" : "每行一个域名，例如\nexample.com";
      scopeHint.textContent = mode === "include"
        ? "只在这些网站上显示，同时包含它们的子域名。列表为空时所有网站都不显示。"
        : "在这些网站上不显示，同时包含它们的子域名。Tessera 站点始终不显示。";
      for (const [value, button] of Object.entries(modeButtons)) button.setAttribute("aria-checked", String(value === mode));
    };
    for (const [value, label] of [["exclude", "所有网站，排除以下"], ["include", "仅以下网站"]]) {
      modeButtons[value] = h("button", { type: "button", role: "radio", onclick: () => { lists[mode] = parseSites(); mode = value; showMode(); } }, label);
    }
    showMode();
    const status = h("div", { className: "status", hidden: true });
    const say = (text, tone = "") => {
      status.hidden = false; status.className = `status ${tone}`; status.textContent = text;
      if (tone === "error") status.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
    const read = () => {
      lists[mode] = parseSites();
      return { server: server.value.trim().replace(/\/+$/, ""), key: key.value.trim(),
        destination: dest.path, destinationPrivate: dest.private, cookies: cookies.checked, fab: showFab.checked,
        cloudBatch: cloudBatch.value.trim() === "" ? NaN : Number(cloudBatch.value),
        siteMode: mode, excludeSites: lists.exclude, includeSites: lists.include };
    };
    const validate = value => {
      const invalid = [...value.excludeSites, ...value.includeSites].find(rule => !normalizeSite(rule));
      if (invalid) return `无法识别的网站：${invalid}（请填写域名，例如 example.com）`;
      if (value.server && !/^https?:\/\/[^/\s]+/.test(value.server)) return "Tessera 地址应以 http:// 或 https:// 开头";
      if (value.key && !/^[^:\s]+:\S+$/.test(value.key)) return "访问密钥格式应为 AccessKeyId:Secret";
      if (!Number.isInteger(value.cloudBatch) || value.cloudBatch < 1 || value.cloudBatch > BATCH_MAX) return `每批文件数应为 1–${BATCH_MAX} 的整数`;
      return "";
    };
    const test = h("button", { type: "button", className: "btn ghost" }, "测试连接");
    test.addEventListener("click", async () => {
      const value = read();
      const problem = validate(value);
      if (problem) return say(problem, "error");
      saveSettings(value);
      say("正在连接…");
      try {
        const me = await api("GET", "/api/v1/me");
        const writable = (me.grants || []).filter(grant => grant.perms === "rw").map(grant => `${grant.bucket}/${grant.prefix}`);
        if (!me.owner) say("密钥不属于任何用户，不能创建离线下载", "error");
        else if (!writable.length) say(`已连接到用户 ${me.owner}，但密钥没有写入权限`, "error");
        else say(`连接成功 · 用户 ${me.owner}`, "ok");
      } catch (error) {
        say(error.message, "error");
      }
    });
    const save = h("button", { type: "button", className: "btn primary" }, "保存");
    save.addEventListener("click", () => {
      const value = read();
      const problem = validate(value);
      if (problem) return say(problem, "error");
      // 规则统一保存为去重后的域名。
      const clean = list => [...new Set(list.map(normalizeSite))];
      saveSettings({ ...value, excludeSites: clean(value.excludeSites), includeSites: clean(value.includeSites) });
      applySiteState();
      refreshFab();
      toast("设置已保存");
      back ? back() : close();
    });
    frame("设置", [
      h("div", { className: "group" },
        h("label", { className: "field" }, h("span", { className: "label" }, "Tessera 地址"), server),
        h("label", { className: "field" }, h("span", { className: "label" }, "访问密钥"), key,
          h("span", { className: "hint" }, "在 Tessera 头像菜单「用户设置 → 访问密钥」中新建，按 Access Key ID:Secret 填写。只保存在 Tampermonkey 中。")),
        h("div", { className: "field" }, h("span", { className: "label" }, "默认保存位置"), destinationRow(() => dest, value => { dest = value; })),
        status),
      h("div", { className: "divider" }),
      h("div", { className: "group" },
        toggleRow(cookies, "附带登录 Cookie", "下载需要登录才能看的内容时使用"),
        toggleRow(showFab, "显示悬浮按钮", "可拖动到屏幕左右两侧，也可以只用 Tampermonkey 菜单打开")),
      h("div", { className: "divider" }),
      h("div", { className: "group" },
        h("label", { className: "field" }, h("span", { className: "label" }, "每批文件数"), cloudBatch,
          h("span", { className: "hint" }, `勾选的网页资源与网盘文件都按这个数量分批发送：每批解析完（网盘先取直链）后创建任务或上传，再处理下一批；勾选数量不限。默认 ${BATCH_DEFAULT}，最多 ${BATCH_MAX}；一批越大，先解析的链接越可能在创建任务前过期。`))),
      h("div", { className: "divider" }),
      h("div", { className: "group" },
        h("div", { className: "field" }, h("span", { className: "label" }, "显示范围"),
          h("div", { className: "segmented", role: "radiogroup", "aria-label": "显示范围" }, Object.values(modeButtons)),
          sites, scopeHint)),
      h("p", { className: "hint" }, "Tessera 资源抓取 · AGPL-3.0-or-later · 无担保",
        h("button", { type: "button", className: "text-btn", onclick: () => gm.openTab("https://github.com/yangshoulai/tgdrive/tree/main/userscripts") }, "源码与许可证")),
    ], { back: back || close, footer: [test, h("span", { className: "spacer" }), save] });
  }

  // ---------- 站内按钮 ----------

  function inlineButton(onclick, title = "Tessera") {
    const button = document.createElement("button");
    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.dataset.tesseraGrabber = "1";
    button.append(icon());
    button.style.cssText = "display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border:0;border-radius:17px;" +
      "background:transparent;color:inherit;cursor:pointer;opacity:.75;flex:none;";
    button.addEventListener("mouseenter", () => { button.style.opacity = "1"; });
    button.addEventListener("mouseleave", () => { button.style.opacity = ".75"; });
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      onclick();
    });
    return button;
  }

  function decorateX() {
    document.querySelectorAll('article[data-testid="tweet"]').forEach(article => {
      const bar = [...article.querySelectorAll('[role="group"]')].pop();
      if (!bar || bar.querySelector("[data-tessera-grabber]")) return;
      const link = article.querySelector('a[href*="/status/"] time')?.closest("a");
      const context = link && platformOf(link.href);
      if (!context) return;
      bar.append(inlineButton(() => open({ ...context, scope: article }), "Tessera：复制或发送这条帖子的媒体"));
    });
  }

  function decorateYouTube() {
    const context = platformOf(location.href);
    const bar = document.querySelector("ytd-watch-metadata #top-level-buttons-computed, ytd-watch-metadata #actions-inner #menu");
    if (!context || !bar || bar.parentElement.querySelector("[data-tessera-grabber]")) return;
    bar.before(inlineButton(() => open(platformOf(location.href)), "Tessera：发送这个视频"));
  }

  let domObserver = null;
  function watchDom() {
    if (domObserver) return;
    const host = location.hostname.replace(/^(www|mobile|m)\./, "");
    const decorate = host === "x.com" || host === "twitter.com" ? decorateX : host === "youtube.com" ? decorateYouTube : null;
    if (!decorate) return;
    let pending = false;
    domObserver = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; if (active) decorate(); }, 400);
    });
    domObserver.observe(document.body, { childList: true, subtree: true });
    decorate();
  }

  // ---------- 单页应用换页 ----------

  // X、YouTube 等单页应用换页不刷新文档：地址变化时主面板切换到新页面，已探测的资源保留（只有手动清空或刷新页面才清除）。
  // X 的图片查看器（/photo/1）不算换页。
  const pageKey = href => { try { const url = new URL(href); return url.origin + url.pathname.replace(/\/(photo|video)\/\d+\/?$/, "") + url.search; } catch { return href; } };
  let currentPage = pageKey(location.href);
  let navTimer = 0;
  function checkNavigation() {
    const key = pageKey(location.href);
    if (!active || key === currentPage) return;
    currentPage = key;
    refreshFab();
    if (!panel || panel.dataset.view !== "main" || (currentContext && currentContext.scope)) return;
    const next = platformOf(location.href);
    if (cloudOf() || (next && next.url) !== (currentContext && currentContext.url)) open(next);
    else renderList();
  }
  function watchNavigation() {
    if (navTimer) return;
    currentPage = pageKey(location.href);
    const navigation = page.navigation || window.navigation;
    try { navigation?.addEventListener("navigatesuccess", () => checkNavigation()); } catch { /* 不支持 Navigation API */ }
    window.addEventListener("popstate", () => checkNavigation());
    navTimer = setInterval(() => checkNavigation(), 1000);
  }

  // ---------- 启动 ----------

  const whenReady = fn => document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn, { once: true }) : fn();

  function activate() {
    if (active) return;
    active = true;
    observeNetwork();
    watchFrames();
    watchNavigation();
    whenReady(() => { if (!active) return; mount(); watchDom(); refreshFab(); });
  }

  /** 停用后立即生效：断开嗅探与站内按钮观察、移除已加的按钮并清空列表，不需要刷新页面。 */
  function deactivate() {
    active = false;
    networkObserver?.disconnect();
    networkObserver = null;
    clearInterval(resourcePoll);
    resourcePoll = null;
    resourceIndex = 0;
    unwatchFrames();
    domObserver?.disconnect();
    domObserver = null;
    document.querySelectorAll("[data-tessera-grabber]").forEach(node => node.remove());
    items.clear();
    clearedUrls.clear();
    close();
    refreshFab();
  }

  let siteMenu = null;
  function updateMenu() {
    gm.unmenu(siteMenu);
    siteMenu = null;
    if (onTessera()) return;
    siteMenu = gm.menu(active ? `在 ${currentSite()} 上停用` : `在 ${currentSite()} 上启用`, () => setSiteEnabled(!active));
  }

  function applySiteState() {
    siteEnabled() ? activate() : deactivate();
    // 没有菜单命令的管理器（iOS Userscripts）：未启用的网站也挂载一个淡化的悬浮按钮，作为重新启用与打开设置的唯一入口。
    if (!active && dormantFab()) whenReady(() => { if (!active && dormantFab()) { mount(); refreshFab(); } });
    updateMenu();
  }

  // iframe 里只运行嗅探代理（见「iframe 中的资源」），不注册菜单、不读取设置、不挂界面。
  if (!IS_TOP) { frameAgent(); return; }

  gm.menu("打开资源面板", () => open());
  gm.menu("设置", () => openSettings());
  // Tessera 站点和被排除的网站上不嗅探、不加按钮；需要时可从脚本管理器菜单（或无菜单时的淡化按钮）打开面板或设置。
  gm.load().then(() => {
    const authorized = captureCloudAuthorization();
    applySiteState();
    if (authorized) whenReady(() => { mount(); toast("百度取链授权已保存，请返回网盘页面重试"); });
    if (!SYNC_STORE) document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      const before = siteEnabled();
      void gm.load().then(() => { if (siteEnabled() !== before) applySiteState(); else refreshFab(); });
    });
  });
})();
