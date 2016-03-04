/* created by Szymon Maslanka and mighty power of internets */
var viewportWidth = $(window).width() ;
var viewportHeight = $(window).height();

function resizetoView(){
  viewportWidth = $(window).width() ;
  viewportHeight = $(window).height();
  $('.screen').height(viewportHeight*0.95);
  $('#section_portfolio').height(viewportHeight*1.60);
 
}

$(document).ready( function(){
  //basic resizing so it fits
  resizetoView();
  $(window).bind('resize', resizetoView);
});



